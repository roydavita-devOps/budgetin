import { randomBytes, randomUUID } from 'node:crypto';

const ACTIVE = ['pending', 'sending', 'notified'];
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const POLL_GAP_RISK = `(last_durable_poll_at IS NOT NULL AND
    (last_durable_poll_at <= clock_timestamp() - INTERVAL '12 hours' OR last_durable_poll_at > clock_timestamp()))
  OR (last_durable_poll_at IS NULL AND EXISTS (SELECT 1 FROM inactivity_cases))`;

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Explicitly invoked by the integrator, never on import or service creation.
export async function ensureInactivitySchema(pool) {
  await transaction(pool, async (client) => {
    await client.query(`ALTER TABLE users
      ADD COLUMN IF NOT EXISTS inactivity_enrolled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_transaction_activity_at TIMESTAMPTZ`);
    await client.query(`CREATE TABLE IF NOT EXISTS inactivity_cases (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{22}$'),
      status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'notified')),
      lease_id UUID,
      lease_until TIMESTAMPTZ,
      retry_after TIMESTAMPTZ,
      purge_retry_after TIMESTAMPTZ,
      notified_at TIMESTAMPTZ,
      purge_after TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CHECK ((status = 'sending') = (lease_id IS NOT NULL AND lease_until IS NOT NULL)),
      CHECK ((status = 'notified') = (notified_at IS NOT NULL AND purge_after IS NOT NULL))
    )`);
    await client.query('ALTER TABLE inactivity_cases ADD COLUMN IF NOT EXISTS purge_retry_after TIMESTAMPTZ');
    await client.query('CREATE INDEX IF NOT EXISTS inactivity_cases_purge_idx ON inactivity_cases (purge_after) WHERE status = \'notified\'');
    await client.query(`CREATE TABLE IF NOT EXISTS inactivity_poll_health (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      poll_token TEXT,
      poll_started_at TIMESTAMPTZ,
      drained_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ,
      owner_id TEXT,
      owner_lease_until TIMESTAMPTZ,
      last_completed_owner TEXT,
      last_completed_token TEXT,
      last_completed_kind TEXT CHECK (last_completed_kind IN ('complete', 'unsafe', 'drained')),
      recovery_required BOOLEAN NOT NULL DEFAULT FALSE,
      last_durable_poll_at TIMESTAMPTZ,
      CHECK ((poll_token IS NULL) = (poll_started_at IS NULL))
    )`);
    await client.query(`ALTER TABLE inactivity_poll_health
      ADD COLUMN IF NOT EXISTS owner_id TEXT,
      ADD COLUMN IF NOT EXISTS owner_lease_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_completed_owner TEXT,
      ADD COLUMN IF NOT EXISTS last_completed_token TEXT,
      ADD COLUMN IF NOT EXISTS last_completed_kind TEXT CHECK (last_completed_kind IN ('complete', 'unsafe', 'drained')),
      ADD COLUMN IF NOT EXISTS recovery_required BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS last_durable_poll_at TIMESTAMPTZ`);
    await client.query(`CREATE TABLE IF NOT EXISTS inactivity_poll_requests (
      owner_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      poll_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (owner_id, request_id)
    )`);
    await client.query('ALTER TABLE inactivity_poll_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()');
    await client.query("CREATE INDEX IF NOT EXISTS inactivity_poll_requests_cleanup_idx ON inactivity_poll_requests (created_at) WHERE status IN ('completed', 'abandoned')");
    await client.query('INSERT INTO inactivity_poll_health (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING');
  });
}

function privateId(value) {
  const id = String(value ?? '');
  return /^[1-9][0-9]*$/.test(id) ? id : null;
}

function activeUser(user) {
  return user && user.inactivity_enrolled_at && !user.is_admin && !user.is_blocked && !user.is_deleted && !user.is_protected;
}

// A newly introduced FK may cascade into data not covered by this service.
async function verifyPurgeForeignKeys(client) {
  const expected = new Map([
    ['users.verified_by', 'n'], ['telegram_accounts.user_id', 'c'],
    ['categories.user_id', 'c'], ['transactions.user_id', 'c'],
    ['refresh_tokens.user_id', 'c'], ['otp_codes.user_id', 'c'], ['deletion_requests.user_id', 'n'],
    ['deletion_requests.admin_user_id', 'n'], ['inactivity_cases.user_id', 'c'],
  ]);
  const result = await client.query(`WITH RECURSIVE affected(oid) AS (
      SELECT 'users'::regclass::oid
      UNION
      SELECT c.conrelid FROM pg_constraint c JOIN affected a ON c.confrelid = a.oid
      WHERE c.contype = 'f'
    )
    SELECT ns.nspname AS child_schema, child.relname AS child_table,
      parent.relname AS parent_table, c.confdeltype AS action,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS child_columns,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS parent_columns
    FROM pg_constraint c JOIN affected a ON a.oid = c.confrelid
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = c.confrelid
    WHERE c.contype = 'f'`);
  const schema = (await client.query('SELECT current_schema() AS name')).rows[0].name;
  for (const row of result.rows) {
    const key = `${row.child_table}.${row.child_columns.join(',')}`;
    if (row.child_schema !== schema || row.parent_table !== 'users' || row.parent_columns.join(',') !== 'id'
      || !expected.has(key) || expected.get(key) !== row.action) {
      throw new Error('Purge refused: unexpected foreign key');
    }
    expected.delete(key);
  }
  if (expected.size) throw new Error('Purge refused: required foreign key missing');
}

async function lockPurgeTables(client) {
  // Phone ownership must not change between the ambiguity check and OTP deletion.
  await client.query('LOCK TABLE users, telegram_accounts, otp_codes, deletion_requests IN SHARE ROW EXCLUSIVE MODE');
}

function phoneKey(phone) {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '');
  return digits.startsWith('0') ? `62${digits.slice(1)}` : digits;
}

function phoneKeySql(column) {
  const digits = `regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g')`;
  return `(CASE WHEN left(${digits}, 1) = '0' THEN '62' || substr(${digits}, 2) ELSE ${digits} END)`;
}

function protectedPhoneSql(alias, parameter) {
  return `(${parameter}::text <> '' AND EXISTS (SELECT 1 FROM (
    SELECT ${alias}.phone_number AS phone_number UNION ALL
    SELECT ta.phone_number FROM telegram_accounts ta WHERE ta.user_id = ${alias}.id
  ) protected_numbers WHERE ${phoneKeySql('protected_numbers.phone_number')} = ${parameter}))`;
}

async function ownerPhones(client, userId) {
  return (await client.query(`SELECT DISTINCT phone_number FROM (
      SELECT phone_number FROM users WHERE id = $1
      UNION ALL SELECT phone_number FROM telegram_accounts WHERE user_id = $1
    ) phones WHERE phone_number IS NOT NULL AND phone_number <> ''`, [userId])).rows.map((row) => row.phone_number);
}

async function phoneIsAmbiguous(client, userId, phone) {
  const key = phoneKey(phone);
  if (!key) return true;
  const result = await client.query(`WITH phones AS (
      SELECT id AS owner_id, regexp_replace(phone_number, '[^0-9]', '', 'g') AS digits FROM users
      UNION ALL SELECT user_id, regexp_replace(phone_number, '[^0-9]', '', 'g') FROM telegram_accounts
    ) SELECT EXISTS (SELECT 1 FROM phones WHERE owner_id <> $1 AND
      CASE WHEN left(digits, 1) = '0' THEN '62' || substr(digits, 2) ELSE digits END = $2) AS present`, [userId, key]);
  return result.rows[0].present;
}

async function lockedUser(client, id, protectedKey, skipLocked = false) {
  const result = await client.query(`SELECT u.id, u.phone_number, u.inactivity_enrolled_at,
      u.last_transaction_activity_at, u.is_admin, u.is_blocked, u.is_deleted,
      ${protectedPhoneSql('u', '$2')} AS is_protected,
      GREATEST(u.inactivity_enrolled_at, u.last_transaction_activity_at) <= clock_timestamp() - INTERVAL '30 days' AS inactive
    FROM users u WHERE u.id = $1 FOR UPDATE OF u${skipLocked ? ' SKIP LOCKED' : ''}`, [id, protectedKey]);
  return result.rows[0];
}

async function purgeLocked(client, user) {
  await verifyPurgeForeignKeys(client);
  const phones = await ownerPhones(client, user.id);
  for (const phone of phones) if (await phoneIsAmbiguous(client, user.id, phone)) throw new Error('Purge refused: phone ownership is ambiguous');
  await client.query(`DELETE FROM deletion_requests d WHERE d.user_id = $1 OR (d.user_id IS NULL AND EXISTS
    (SELECT 1 FROM telegram_accounts ta WHERE ta.user_id = $1 AND ta.telegram_user_id = d.requester_telegram_user_id))`, [user.id]);
  for (const phone of phones) {
    await client.query(`DELETE FROM otp_codes WHERE ${phoneKeySql('phone_number')} = $2 AND (user_id = $1 OR user_id IS NULL)`, [user.id, phoneKey(phone)]);
  }
  await client.query('DELETE FROM users WHERE id = $1', [user.id]);
}

export function createInactivityService({ pool, sendAlert, invalidateCache, protectedPhone, autoPurgeEnabled = false, leaseSeconds = 120, retrySeconds = 60, pollLeaseSeconds = 120 }) {
  if (!pool || typeof pool.connect !== 'function' || typeof sendAlert !== 'function') throw new TypeError('pool and sendAlert are required');
  if (invalidateCache !== undefined && typeof invalidateCache !== 'function') throw new TypeError('invalidateCache must be a function');
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || !Number.isSafeInteger(retrySeconds) || retrySeconds < 1) throw new TypeError('invalid lease or retry interval');
  if (!Number.isSafeInteger(pollLeaseSeconds) || pollLeaseSeconds < 1) throw new TypeError('invalid poll lease');
  const protectedKey = phoneKey(protectedPhone);
  if (protectedPhone && !protectedKey) throw new TypeError('invalid protected phone');

  async function invalidate(userId) {
    if (!invalidateCache) return true;
    try { await invalidateCache(userId); return false; } catch { return true; }
  }

  async function findCandidates(limit) {
    const precheck = await pool.query(`SELECT EXISTS (SELECT 1 FROM users u
      WHERE u.inactivity_enrolled_at IS NOT NULL AND NOT u.is_admin AND NOT u.is_blocked AND NOT u.is_deleted
        AND NOT ${protectedPhoneSql('u', '$1')}
        AND GREATEST(u.inactivity_enrolled_at, u.last_transaction_activity_at) <= clock_timestamp() - INTERVAL '30 days'
        AND NOT EXISTS (SELECT 1 FROM inactivity_cases c WHERE c.user_id = u.id)) AS present`, [protectedKey]);
    if (!precheck.rows[0].present) return { created: 0, enrollmentFailures: 0 };
    return transaction(pool, async (client) => {
      await client.query('LOCK TABLE users, telegram_accounts, otp_codes, refresh_tokens IN SHARE ROW EXCLUSIVE MODE');
      const candidates = await client.query(`SELECT u.id FROM users u
        WHERE u.inactivity_enrolled_at IS NOT NULL AND NOT u.is_admin AND NOT u.is_blocked AND NOT u.is_deleted
          AND NOT ${protectedPhoneSql('u', '$2')}
          AND GREATEST(u.inactivity_enrolled_at, u.last_transaction_activity_at) <= clock_timestamp() - INTERVAL '30 days'
          AND NOT EXISTS (SELECT 1 FROM inactivity_cases c WHERE c.user_id = u.id)
        ORDER BY GREATEST(u.inactivity_enrolled_at, u.last_transaction_activity_at), u.id
        LIMIT $1 FOR UPDATE OF u SKIP LOCKED`, [limit, protectedKey]);
      let created = 0;
      let enrollmentFailures = 0;
      for (const row of candidates.rows) {
        await client.query('SAVEPOINT inactivity_candidate');
        try {
          const inserted = await client.query(`INSERT INTO inactivity_cases (user_id, token, status)
            VALUES ($1, $2, 'pending') ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [row.id, randomBytes(16).toString('base64url')]);
          if (inserted.rowCount) {
            await client.query('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE user_id = $1', [row.id]);
            const phones = await ownerPhones(client, row.id);
            for (const phone of phones) {
              if (!(await phoneIsAmbiguous(client, row.id, phone))) {
                await client.query(`UPDATE otp_codes SET consumed_at = clock_timestamp()
                  WHERE ${phoneKeySql('phone_number')} = $2 AND (user_id = $1 OR user_id IS NULL)
                    AND consumed_at IS NULL AND expires_at > clock_timestamp()`, [row.id, phoneKey(phone)]);
              }
            }
            created++;
          }
          await client.query('RELEASE SAVEPOINT inactivity_candidate');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT inactivity_candidate');
          await client.query('RELEASE SAVEPOINT inactivity_candidate');
          enrollmentFailures++;
        }
      }
      return { created, enrollmentFailures };
    });
  }

  async function claimAlert(id) {
    return transaction(pool, async (client) => {
      const user = await lockedUser(client, id, protectedKey, true);
      if (!activeUser(user)) return null;
      const result = await client.query('SELECT * FROM inactivity_cases WHERE user_id = $1 FOR UPDATE', [id]);
      const item = result.rows[0];
      if (!item || !user.inactive || item.status === 'notified') return null;
      const eligible = await client.query(`SELECT 1 WHERE ($2::timestamptz IS NULL OR $2 <= clock_timestamp())
        AND ($1::text = 'pending' OR ($1::text = 'sending' AND $3::timestamptz <= clock_timestamp()))`, [item.status, item.retry_after, item.lease_until]);
      if (!eligible.rowCount) return null;
      const account = await client.query(`SELECT telegram_user_id, telegram_chat_id FROM telegram_accounts
        WHERE user_id = $1 AND telegram_user_id ~ '^[1-9][0-9]*$' AND telegram_chat_id = telegram_user_id
        ORDER BY linked_at DESC, id LIMIT 1`, [id]);
      if (!account.rowCount) {
        await client.query(`UPDATE inactivity_cases SET status = 'pending', lease_id = NULL, lease_until = NULL,
          retry_after = clock_timestamp() + ($2::int * INTERVAL '1 second') WHERE user_id = $1`, [id, retrySeconds]);
        return { unavailable: true };
      }
      const leaseId = randomUUID();
      await client.query(`UPDATE inactivity_cases SET status = 'sending', lease_id = $2,
        lease_until = clock_timestamp() + ($3::int * INTERVAL '1 second'), retry_after = NULL WHERE user_id = $1`, [id, leaseId, leaseSeconds]);
      return { id, token: item.token, leaseId, telegramUserId: account.rows[0].telegram_user_id, chatId: account.rows[0].telegram_chat_id };
    });
  }

  async function finishAlert(claim, confirmed) {
    return transaction(pool, async (client) => {
      const user = await lockedUser(client, claim.id, protectedKey);
      if (!activeUser(user) || !user.inactive) return false;
      const update = confirmed
        ? `UPDATE inactivity_cases SET status = 'notified', lease_id = NULL, lease_until = NULL,
             notified_at = clock_timestamp(), purge_after = clock_timestamp() + INTERVAL '48 hours'
           WHERE user_id = $1 AND status = 'sending' AND lease_id = $2 AND token = $3`
        : `UPDATE inactivity_cases SET status = 'pending', lease_id = NULL, lease_until = NULL,
             retry_after = clock_timestamp() + ($4::int * INTERVAL '1 second')
           WHERE user_id = $1 AND status = 'sending' AND lease_id = $2 AND token = $3`;
      const result = await client.query(update, confirmed ? [claim.id, claim.leaseId, claim.token] : [claim.id, claim.leaseId, claim.token, retrySeconds]);
      return result.rowCount === 1;
    });
  }

  async function purgeDue(id) {
    if (!autoPurgeEnabled) return false;
    return transaction(pool, async (client) => {
      await lockPurgeTables(client);
      const user = await lockedUser(client, id, protectedKey, true);
      if (!activeUser(user) || !user.inactive) return false;
      const item = await client.query(`SELECT purge_after FROM inactivity_cases WHERE user_id = $1 AND status = 'notified'
        AND purge_after <= clock_timestamp() FOR UPDATE`, [id]);
      if (!item.rowCount) return false;
      const health = await client.query(`SELECT 1 FROM inactivity_poll_health
        WHERE id = TRUE AND NOT recovery_required AND poll_token IS NULL AND owner_id IS NOT NULL
          AND owner_lease_until > clock_timestamp() AND drained_at >= $1
          AND last_durable_poll_at > clock_timestamp() - INTERVAL '12 hours'
          AND last_durable_poll_at <= clock_timestamp()
          AND drained_at > clock_timestamp() - INTERVAL '2 minutes'
          AND confirmed_at > clock_timestamp() - INTERVAL '2 minutes' FOR SHARE`, [item.rows[0].purge_after]);
      if (!health.rowCount) return false;
      await purgeLocked(client, user);
      return true;
    });
  }

  async function runOnce({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be between 1 and 1000');
    await pool.query(`DELETE FROM inactivity_poll_requests WHERE ctid IN (
      SELECT ctid FROM inactivity_poll_requests WHERE status IN ('completed', 'abandoned')
        AND created_at < clock_timestamp() - INTERVAL '7 days' LIMIT 1000
    )`);
    const { created, enrollmentFailures } = await findCandidates(limit);
    const alerts = await pool.query(`SELECT c.user_id FROM inactivity_cases c JOIN users u ON u.id = c.user_id
      WHERE u.inactivity_enrolled_at IS NOT NULL AND NOT u.is_admin AND NOT u.is_blocked AND NOT u.is_deleted
        AND NOT ${protectedPhoneSql('u', '$2')}
        AND GREATEST(u.inactivity_enrolled_at, u.last_transaction_activity_at) <= clock_timestamp() - INTERVAL '30 days'
        AND (c.retry_after IS NULL OR c.retry_after <= clock_timestamp())
        AND (c.status = 'pending' OR (c.status = 'sending' AND c.lease_until <= clock_timestamp())) ORDER BY c.created_at LIMIT $1`, [limit, protectedKey]);
    let notified = 0;
    let alertFailures = 0;
    for (const { user_id: id } of alerts.rows) {
      let failureCounted = false;
      try {
        const claim = await claimAlert(id);
        if (!claim) continue;
        if (claim.unavailable) { alertFailures++; continue; }
        let confirmed = false;
        try {
        confirmed = (await sendAlert({ telegramUserId: claim.telegramUserId, chatId: claim.chatId,
          text: autoPurgeEnabled
            ? 'Akun kamu tidak mencatat transaksi selama 30 hari. Pertahankan akun untuk mengaktifkannya kembali. Hapus akun akan langsung menghapus akun dan semua data di database secara permanen. Jika tidak merespons, akun dan semua data di database akan dihapus permanen paling cepat 2 hari setelah peringatan ini.'
            : 'Akun kamu tidak mencatat transaksi selama 30 hari. Pertahankan akun untuk mengaktifkannya kembali. Hapus akun akan langsung menghapus akun dan semua data di database secara permanen. Penghapusan otomatis tanpa respons sedang tidak aktif.',
            reply_markup: { inline_keyboard: [[
              { text: 'Pertahankan akun', callback_data: `inactive:keep:${claim.token}` },
              { text: 'Hapus akun', callback_data: `inactive:delete:${claim.token}` },
            ]] } })) === true;
        } catch { /* Delivery may have succeeded; a callback remains valid. */ }
        if (!confirmed) { alertFailures++; failureCounted = true; }
        if (await finishAlert(claim, confirmed) && confirmed) notified++;
      } catch {
        if (!failureCounted) alertFailures++;
        await pool.query(`UPDATE inactivity_cases SET retry_after = clock_timestamp() + ($2::int * INTERVAL '1 second')
          WHERE user_id = $1 AND status IN ('pending', 'sending')`, [id, retrySeconds]).catch(() => {});
      }
    }
    return { created, enrollmentFailures, notified, alertFailures, ...await purgeEligible({ limit: Math.min(limit, 5) }) };
  }

  async function purgeEligible({ limit = 5 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new TypeError('purge limit must be between 1 and 5');
    if (!autoPurgeEnabled) return { purged: 0, purgeDeferred: 0, purgeFailures: 0, cacheInvalidationFailures: 0 };
    const due = await pool.query(`SELECT c.user_id FROM inactivity_cases c JOIN users u ON u.id = c.user_id
      WHERE c.status = 'notified' AND c.purge_after <= clock_timestamp()
        AND (c.purge_retry_after IS NULL OR c.purge_retry_after <= clock_timestamp()) AND u.inactivity_enrolled_at IS NOT NULL
        AND NOT u.is_admin AND NOT u.is_blocked AND NOT u.is_deleted
        AND NOT ${protectedPhoneSql('u', '$2')}
        AND GREATEST(u.inactivity_enrolled_at, u.last_transaction_activity_at) <= clock_timestamp() - INTERVAL '30 days'
      ORDER BY c.purge_after LIMIT $1`, [limit, protectedKey]);
    let purged = 0;
    let purgeDeferred = 0;
    let cacheInvalidationFailures = 0;
    let purgeFailures = 0;
    for (const { user_id: id } of due.rows) {
      try {
        if (await purgeDue(id)) { purged++; if (await invalidate(id)) cacheInvalidationFailures++; }
        else purgeDeferred++;
      } catch {
        purgeFailures++;
        await pool.query(`UPDATE inactivity_cases SET purge_retry_after = clock_timestamp() + ($2::int * INTERVAL '1 second')
          WHERE user_id = $1 AND status = 'notified'`, [id, retrySeconds]).catch(() => {});
      }
    }
    return { purged, purgeDeferred, purgeFailures, cacheInvalidationFailures };
  }

  async function handleCallback({ telegramUserId, chatId, data } = {}) {
    const owner = privateId(telegramUserId);
    const chat = privateId(chatId);
    const match = /^inactive:(keep|delete):([A-Za-z0-9_-]{22})$/.exec(String(data ?? ''));
    if (!owner || owner !== chat || !match || !TOKEN.test(match[2])) return { outcome: 'invalid' };
    const [action, token] = [match[1], match[2]];
    const result = await transaction(pool, async (client) => {
      if (action === 'delete') await lockPurgeTables(client);
      else await client.query('LOCK TABLE users IN ROW EXCLUSIVE MODE');
      const lookup = await client.query(`SELECT c.user_id FROM inactivity_cases c JOIN telegram_accounts ta ON ta.user_id = c.user_id
        WHERE c.token = $1 AND ta.telegram_user_id = $2 AND ta.telegram_chat_id = $3`, [token, owner, chat]);
      if (!lookup.rowCount) return { outcome: 'invalid' };
      const user = await lockedUser(client, lookup.rows[0].user_id, protectedKey);
      if (!activeUser(user) || !user.inactive) return { outcome: 'invalid' };
      const current = await client.query('SELECT status FROM inactivity_cases WHERE user_id = $1 AND token = $2 FOR UPDATE', [user.id, token]);
      if (!current.rowCount || !ACTIVE.includes(current.rows[0].status)) return { outcome: 'invalid' };
      // Recheck the link after locking the user; integrations must lock the same user for relinking.
      const linked = await client.query('SELECT 1 FROM telegram_accounts WHERE user_id = $1 AND telegram_user_id = $2 AND telegram_chat_id = $3', [user.id, owner, chat]);
      if (!linked.rowCount) return { outcome: 'invalid' };
      if (action === 'keep') {
        await client.query('UPDATE users SET inactivity_enrolled_at = clock_timestamp() WHERE id = $1', [user.id]);
        await client.query('DELETE FROM inactivity_cases WHERE user_id = $1', [user.id]);
        return { outcome: 'kept' };
      }
      await purgeLocked(client, user);
      return { outcome: 'deleted', userId: user.id };
    });
    if (result.outcome === 'deleted') {
      const cacheInvalidationFailed = await invalidate(result.userId);
      return { outcome: 'deleted', cacheInvalidationFailed };
    }
    return result;
  }

  async function beginPoll({ ownerId, requestId } = {}) {
    if (typeof ownerId !== 'string' || !TOKEN.test(ownerId)) throw new TypeError('invalid poll owner');
    if (typeof requestId !== 'string' || !TOKEN.test(requestId)) throw new TypeError('invalid poll request');
    const token = randomBytes(16).toString('base64url');
    return transaction(pool, async (client) => {
      const health = await client.query('SELECT owner_id, poll_token FROM inactivity_poll_health WHERE id = TRUE FOR UPDATE');
      if (!health.rowCount) throw new Error('Inactivity poll health is not initialized');
      const previous = await client.query(`SELECT poll_token, status FROM inactivity_poll_requests
        WHERE owner_id = $1 AND request_id = $2`, [ownerId, requestId]);
      if (previous.rowCount) {
        if (previous.rows[0].status === 'active' && health.rows[0].owner_id === ownerId
          && health.rows[0].poll_token === previous.rows[0].poll_token) {
          return { token: previous.rows[0].poll_token, outcome: 'duplicate' };
        }
        const error = new Error('Poll request no longer active');
        error.code = 'POLL_REQUEST_COMPLETED';
        throw error;
      }
      const result = await client.query(`UPDATE inactivity_poll_health SET poll_token = $1, poll_started_at = clock_timestamp(),
        owner_id = $2, owner_lease_until = clock_timestamp() + ($3::int * INTERVAL '1 second'),
        last_completed_owner = CASE WHEN owner_id IS DISTINCT FROM $2 THEN NULL ELSE last_completed_owner END,
        last_completed_token = CASE WHEN owner_id IS DISTINCT FROM $2 THEN NULL ELSE last_completed_token END,
        last_completed_kind = CASE WHEN owner_id IS DISTINCT FROM $2 THEN NULL ELSE last_completed_kind END,
        recovery_required = recovery_required OR (poll_token IS NOT NULL AND owner_id IS DISTINCT FROM $2) OR (${POLL_GAP_RISK}),
        drained_at = NULL, confirmed_at = NULL
      WHERE id = TRUE AND (
        (poll_token IS NULL AND (owner_id IS NULL OR owner_id = $2 OR owner_lease_until <= clock_timestamp()))
        OR (owner_id IS DISTINCT FROM $2 AND owner_lease_until <= clock_timestamp())
      ) RETURNING id`, [token, ownerId, pollLeaseSeconds]);
      if (!result.rowCount) {
        const error = new Error('Poll owner unavailable');
        error.code = 'POLL_UNAVAILABLE';
        throw error;
      }
      if (health.rows[0].poll_token) {
        await client.query(`UPDATE inactivity_poll_requests SET status = 'abandoned'
          WHERE owner_id = $1 AND poll_token = $2 AND status = 'active'`, [health.rows[0].owner_id, health.rows[0].poll_token]);
      }
      await client.query(`INSERT INTO inactivity_poll_requests (owner_id, request_id, poll_token, status)
        VALUES ($1, $2, $3, 'active')`, [ownerId, requestId, token]);
      return { token, outcome: 'new' };
    });
  }

  async function resetPollingHealth() {
    await transaction(pool, async (client) => {
      const health = await client.query('SELECT owner_id, poll_token FROM inactivity_poll_health WHERE id = TRUE FOR UPDATE');
      if (!health.rowCount) throw new Error('Inactivity poll health is not initialized');
      if (health.rows[0].poll_token) {
        await client.query(`UPDATE inactivity_poll_requests SET status = 'abandoned'
          WHERE owner_id = $1 AND poll_token = $2 AND status = 'active'`, [health.rows[0].owner_id, health.rows[0].poll_token]);
      }
      await client.query(`UPDATE inactivity_poll_health SET recovery_required = recovery_required OR poll_token IS NOT NULL OR (${POLL_GAP_RISK}),
      poll_token = NULL, poll_started_at = NULL, drained_at = NULL, confirmed_at = NULL,
      owner_id = NULL, owner_lease_until = NULL, last_completed_owner = NULL,
      last_completed_token = NULL, last_completed_kind = NULL WHERE id = TRUE`);
    });
  }

  async function finishPoll({ ownerId, token }, kind, statement) {
    if (typeof token !== 'string' || !TOKEN.test(token) || typeof ownerId !== 'string' || !TOKEN.test(ownerId)) return false;
    return transaction(pool, async (client) => {
      const result = await client.query(statement, [ownerId, token, pollLeaseSeconds, kind]);
      if (result.rowCount) {
        await client.query(`UPDATE inactivity_poll_requests SET status = 'completed'
          WHERE owner_id = $1 AND poll_token = $2 AND status = 'active'`, [ownerId, token]);
        return 'new';
      }
      const replay = await client.query(`SELECT 1 FROM inactivity_poll_health WHERE id = TRUE AND owner_id = $1
        AND last_completed_owner = $1 AND last_completed_token = $2 AND last_completed_kind = $3`, [ownerId, token, kind]);
      return replay.rowCount ? 'duplicate' : false;
    });
  }

  async function completePollBatch({ ownerId, token } = {}) {
    return finishPoll({ ownerId, token }, 'complete', `UPDATE inactivity_poll_health SET poll_started_at = NULL, poll_token = NULL,
      recovery_required = recovery_required OR (${POLL_GAP_RISK}), last_durable_poll_at = clock_timestamp(),
      drained_at = NULL, confirmed_at = NULL, owner_lease_until = clock_timestamp() + ($3::int * INTERVAL '1 second'),
      last_completed_owner = $1, last_completed_token = $2, last_completed_kind = $4
      WHERE id = TRUE AND owner_id = $1 AND poll_token = $2 RETURNING id`);
  }

  async function markPollUnsafe({ ownerId, token } = {}) {
    return finishPoll({ ownerId, token }, 'unsafe', `UPDATE inactivity_poll_health SET recovery_required = TRUE,
      poll_started_at = NULL, poll_token = NULL, drained_at = NULL, confirmed_at = NULL,
      owner_lease_until = clock_timestamp() + ($3::int * INTERVAL '1 second'),
      last_completed_owner = $1, last_completed_token = $2, last_completed_kind = $4
      WHERE id = TRUE AND owner_id = $1 AND poll_token = $2 RETURNING id`);
  }

  async function confirmPollDrained({ ownerId, token } = {}) {
    return finishPoll({ ownerId, token }, 'drained', `UPDATE inactivity_poll_health SET drained_at = poll_started_at,
      confirmed_at = clock_timestamp(), poll_started_at = NULL, poll_token = NULL,
      recovery_required = recovery_required OR (${POLL_GAP_RISK}), last_durable_poll_at = clock_timestamp(),
      owner_lease_until = clock_timestamp() + ($3::int * INTERVAL '1 second'),
      last_completed_owner = $1, last_completed_token = $2, last_completed_kind = $4
      WHERE id = TRUE AND owner_id = $1 AND poll_token = $2 RETURNING id`);
  }

  return { runOnce, purgeEligible, handleCallback, beginPoll, completePollBatch, markPollUnsafe, confirmPollDrained, resetPollingHealth };
}
