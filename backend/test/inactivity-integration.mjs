// Opt-in: node backend/test/inactivity-integration.mjs. No environment files or existing databases are used.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createInactivityService as createService, ensureInactivitySchema } from '../src/inactivity.js';

const createInactivityService = (options) => {
  const service = createService({ autoPurgeEnabled: true, ...options });
  return { ...service, beginPoll: (args) => service.beginPoll({ requestId: randomBytes(16).toString('base64url'), ...args }) };
};

const suffix = randomBytes(8).toString('hex');
const name = `budgetin-inactivity-test-${suffix}`;
const password = randomBytes(24).toString('hex');
const sql = await readFile(fileURLToPath(new URL('../../database/init/001_schema.sql', import.meta.url)), 'utf8');
let root;
let started = false;
let serial = 0;
const pools = [];

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}
async function cleanup() {
  for (const pool of pools) await pool.end().catch(() => {});
  if (root) await root.end().catch(() => {});
  if (started) { try { docker('rm', '-f', '-v', name); } catch { console.error(`Remove only test container ${name} manually.`); } }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup().finally(() => process.exit(130)); });

async function eventually(fn) {
  for (let i = 0; i < 120; i++) {
    try { return await fn(); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error('Isolated Postgres did not start');
}
async function setup() {
  const schema = `inactivity_test_${++serial}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ host: '127.0.0.1', port: root.options.port, user: 'synthetic', password,
    database: 'synthetic', ssl: false, options: `-c search_path=${schema},public`, connectionTimeoutMillis: 1000 });
  pools.push(pool);
  await pool.query(sql);
  await pool.query('ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE');
  await pool.query(`CREATE TABLE refresh_tokens (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await ensureInactivitySchema(pool);
  await ensureInactivitySchema(pool);
  await pool.query('UPDATE inactivity_poll_health SET last_durable_poll_at = clock_timestamp() WHERE id = TRUE');
  return pool;
}
let sequence = 30000;
async function user(pool, opts = {}) {
  const id = String(++sequence);
  const phone = `+628${id}`;
  const result = await pool.query(`INSERT INTO users (phone_number, is_admin, is_blocked, is_deleted,
    inactivity_enrolled_at, last_transaction_activity_at)
    VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN clock_timestamp() - INTERVAL '30 days' ELSE NULL END,
      CASE WHEN $6 THEN clock_timestamp() ELSE NULL END) RETURNING id`,
  [phone, !!opts.admin, !!opts.blocked, !!opts.deleted, opts.enrolled !== false, !!opts.recent]);
  const userId = result.rows[0].id;
  if (opts.link !== false) await pool.query(`INSERT INTO telegram_accounts (user_id, telegram_user_id, telegram_chat_id, phone_number)
    VALUES ($1,$2,$3,$4)`, [userId, id, opts.chat ?? id, phone]);
  return { userId, telegramUserId: id, chatId: id, phone };
}
async function one(pool, sqlText, params = []) { return (await pool.query(sqlText, params)).rows[0]; }
async function test(label, fn) { await fn(); console.log(`PASS ${label}`); }
const ownerId = randomBytes(16).toString('base64url');
async function drained(service) {
  const { token } = await service.beginPoll({ ownerId, requestId: randomBytes(16).toString('base64url') });
  assert.equal(await service.confirmPollDrained({ ownerId, token }), 'new');
  assert.equal(await service.confirmPollDrained({ ownerId, token }), 'duplicate');
}

if (process.env.NODE_TEST_CONTEXT) {
  console.log('Inactivity integration skipped: run directly to use isolated Docker Postgres.');
} else try {
  docker('run', '-d', '--pull=never', '--name', name, '--label', 'budgetin.integration=temporary',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_USER=synthetic', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=synthetic', 'postgres:16-alpine');
  started = true;
  const match = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', name, '5432/tcp'));
  assert.ok(match, 'container must bind IPv4 loopback');
  root = new pg.Pool({ host: '127.0.0.1', port: Number(match[1]), user: 'synthetic', password,
    database: 'synthetic', ssl: false, connectionTimeoutMillis: 1000 });
  await eventually(() => root.query('SELECT 1'));
  await root.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');

  await test('legacy, admin, blocked, deleted, baseline, private delivery and thresholds', async () => {
    const pool = await setup();
    const target = await user(pool);
    for (const opts of [{ enrolled: false }, { admin: true }, { blocked: true }, { deleted: true }, { recent: true }]) await user(pool, opts);
    const future = await user(pool);
    await pool.query("UPDATE users SET inactivity_enrolled_at = clock_timestamp() - INTERVAL '30 days' + INTERVAL '1 minute' WHERE id = $1", [future.userId]);
    const nonprivate = await user(pool, { chat: '-1001' });
    await pool.query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, 'first', NOW() + INTERVAL '2 days')", [target.userId]);
    await pool.query("INSERT INTO otp_codes (phone_number, code_hash, expires_at) VALUES ($1, 'test', NOW() + INTERVAL '1 hour')", [target.phone]);
    const alerts = [];
    const svc = createInactivityService({ pool, sendAlert: async (message) => { alerts.push(message); return true; } });
    const result = await svc.runOnce();
    assert.equal(result.created, 2);
    assert.equal(result.notified, 1);
    assert.equal(alerts[0].chatId, target.chatId);
    assert.match(alerts[0].text, /2 hari/);
    assert.match(alerts[0].text, /langsung/);
    assert.match(alerts[0].text, /permanen/);
    assert.deepEqual(alerts[0].reply_markup.inline_keyboard[0].map((x) => x.text), ['Pertahankan akun', 'Hapus akun']);
    assert.match(alerts[0].reply_markup.inline_keyboard[0][0].callback_data, /^inactive:keep:[A-Za-z0-9_-]{22}$/);
    assert.ok((await one(pool, 'SELECT revoked_at FROM refresh_tokens WHERE user_id=$1', [target.userId])).revoked_at);
    assert.ok((await one(pool, 'SELECT consumed_at FROM otp_codes WHERE phone_number=$1', [target.phone])).consumed_at);
    assert.equal((await one(pool, 'SELECT status FROM inactivity_cases WHERE user_id=$1', [nonprivate.userId])).status, 'pending');
    const c = await one(pool, "SELECT status, purge_after - notified_at AS interval, purge_after > clock_timestamp() AS future FROM inactivity_cases WHERE user_id=$1", [target.userId]);
    assert.equal(c.status, 'notified'); assert.ok(c.future); assert.ok(c.interval.days === 2 || c.interval.hours === 48);
    assert.equal((await svc.runOnce()).purged, 0);
  });

  await test('protected phone excludes an unflagged admin at every stage', async () => {
    const pool = await setup();
    const target = await user(pool);
    let data;
    const protectedSvc = createInactivityService({ pool, protectedPhone: target.phone, sendAlert: async () => { throw new Error('must not send'); } });
    assert.equal((await protectedSvc.runOnce()).created, 0);
    const unprotected = createInactivityService({ pool, sendAlert: async (m) => { data = m.reply_markup.inline_keyboard[0][1].callback_data; return true; } });
    await unprotected.runOnce();
    assert.equal((await protectedSvc.handleCallback({ ...target, data })).outcome, 'invalid');
    await pool.query('UPDATE inactivity_cases SET purge_after=clock_timestamp() WHERE user_id=$1', [target.userId]);
    await drained(protectedSvc);
    assert.equal((await protectedSvc.purgeEligible()).purged, 0);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM users WHERE id=$1', [target.userId])).n, 1);
  });

  await test('automatic purge remains disabled by default even when a case is due', async () => {
    const pool = await setup();
    const target = await user(pool);
    let alertText;
    const svc = createService({ pool, sendAlert: async (message) => { alertText = message.text; return true; } });
    await svc.runOnce();
    assert.match(alertText, /Penghapusan otomatis tanpa respons sedang tidak aktif/);
    await pool.query('UPDATE inactivity_cases SET purge_after = clock_timestamp() WHERE user_id = $1', [target.userId]);
    await drained(svc);
    assert.equal((await svc.purgeEligible()).purged, 0);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM users WHERE id=$1', [target.userId])).n, 1);
  });

  await test('no eligible candidates avoids the global write lock', async () => {
    const pool = await setup();
    await user(pool, { enrolled: false });
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN ROW EXCLUSIVE MODE');
    const svc = createInactivityService({ pool, sendAlert: async () => true });
    try {
      const result = await Promise.race([svc.runOnce(), new Promise((_, reject) => setTimeout(() => reject(new Error('unexpected global lock')), 1000))]);
      assert.equal(result.created, 0);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  await test('failed send, retry, ambiguous phone protection, and callback proof', async () => {
    const pool = await setup();
    const target = await user(pool);
    const other = await user(pool, { recent: true });
    await pool.query('UPDATE telegram_accounts SET phone_number=$1 WHERE user_id=$2', [target.phone, other.userId]);
    await pool.query("INSERT INTO otp_codes (phone_number, code_hash, expires_at) VALUES ($1, 'test', NOW() + INTERVAL '1 hour')", [target.phone]);
    let calls = 0; let data;
    const svc = createInactivityService({ pool, retrySeconds: 1, sendAlert: async (m) => { calls++; data = m.reply_markup.inline_keyboard[0][0].callback_data; throw Error('uncertain'); } });
    await svc.runOnce();
    assert.equal(calls, 1);
    assert.equal((await one(pool, 'SELECT status FROM inactivity_cases WHERE user_id=$1', [target.userId])).status, 'pending');
    assert.equal((await one(pool, 'SELECT consumed_at FROM otp_codes WHERE phone_number=$1', [target.phone])).consumed_at, null);
    await pool.query("UPDATE inactivity_cases SET created_at=clock_timestamp()-INTERVAL '3 days', retry_after=clock_timestamp()+INTERVAL '1 hour' WHERE user_id=$1", [target.userId]);
    assert.equal((await svc.runOnce()).purged, 0);
    await pool.query("UPDATE inactivity_cases SET retry_after = clock_timestamp() - INTERVAL '1 second' WHERE user_id=$1", [target.userId]);
    await svc.runOnce(); assert.equal(calls, 2);
    assert.deepEqual(await svc.handleCallback({ ...target, data }), { outcome: 'kept' });
    assert.equal((await svc.handleCallback({ ...target, data })).outcome, 'invalid');
    assert.equal((await svc.runOnce()).created, 0);
  });

  await test('callback before delivery acknowledgment and replay/identity protection', async () => {
    const pool = await setup();
    const target = await user(pool);
    await pool.query("UPDATE users SET last_transaction_activity_at=clock_timestamp()-INTERVAL '31 days' WHERE id=$1", [target.userId]);
    let svc; let callback;
    svc = createInactivityService({ pool, sendAlert: async (message) => {
      callback = message.reply_markup.inline_keyboard[0][0].callback_data;
      assert.equal((await svc.handleCallback({ telegramUserId: target.telegramUserId, chatId: '-1', data: callback })).outcome, 'invalid');
      assert.equal((await svc.handleCallback({ telegramUserId: '999999', chatId: '999999', data: callback })).outcome, 'invalid');
      assert.equal((await svc.handleCallback({ ...target, data: callback })).outcome, 'kept');
      return true;
    } });
    const result = await svc.runOnce();
    assert.equal(result.notified, 0);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM inactivity_cases')).n, 0);
    assert.equal((await svc.handleCallback({ ...target, data: callback })).outcome, 'invalid');
    assert.equal((await svc.runOnce()).created, 0);
  });

  await test('multiple workers and stale delivery acknowledgment respect lease', async () => {
    const pool = await setup();
    const target = await user(pool);
    let releaseFirst; let startedFirst;
    const started = new Promise((resolve) => { startedFirst = resolve; });
    const blocked = new Promise((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const svc = createInactivityService({ pool, sendAlert: async () => {
      calls++;
      if (calls === 1) { startedFirst(); await blocked; }
      return true;
    } });
    const first = svc.runOnce();
    await started;
    assert.equal((await svc.runOnce()).notified, 0);
    assert.equal(calls, 1);
    await pool.query("UPDATE inactivity_cases SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE user_id=$1", [target.userId]);
    assert.equal((await svc.runOnce()).notified, 1);
    assert.equal(calls, 2);
    releaseFirst();
    assert.equal((await first).notified, 0);
    assert.equal((await one(pool, 'SELECT status FROM inactivity_cases WHERE user_id=$1', [target.userId])).status, 'notified');
  });

  await test('one recipient failure and lease database failure do not stop other alerts', async () => {
    const pool = await setup();
    const failed = await user(pool);
    const broken = await user(pool);
    const good = await user(pool);
    await pool.query(`CREATE FUNCTION synthetic_claim_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id = '${broken.userId}'::uuid AND NEW.status = 'sending' THEN
        RAISE EXCEPTION 'synthetic claim failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER synthetic_claim_failure BEFORE UPDATE ON inactivity_cases FOR EACH ROW EXECUTE FUNCTION synthetic_claim_failure()');
    const svc = createInactivityService({ pool, sendAlert: async (m) => {
      if (m.telegramUserId === failed.telegramUserId) throw new Error('synthetic delivery failure');
      return true;
    } });
    const result = await svc.runOnce();
    assert.equal(result.alertFailures, 2);
    assert.equal(result.notified, 1);
    assert.equal((await one(pool, 'SELECT status FROM inactivity_cases WHERE user_id=$1', [good.userId])).status, 'notified');
    assert.equal((await one(pool, 'SELECT status FROM inactivity_cases WHERE user_id=$1', [failed.userId])).status, 'pending');
    assert.ok((await one(pool, 'SELECT retry_after > clock_timestamp() AS retry FROM inactivity_cases WHERE user_id=$1', [broken.userId])).retry);
  });

  await test('concurrent keep and delete do not deadlock and cannot both succeed', async () => {
    const pool = await setup();
    const target = await user(pool); let buttons;
    const svc = createInactivityService({ pool, sendAlert: async (m) => { buttons = m.reply_markup.inline_keyboard[0]; return true; } });
    await svc.runOnce();
    const outcomes = await Promise.all(buttons.map((button) => svc.handleCallback({ ...target, data: button.callback_data })));
    assert.equal(outcomes.filter((result) => ['kept', 'deleted'].includes(result.outcome)).length, 1);
    assert.equal(outcomes.filter((result) => result.outcome === 'invalid').length, 1);
  });

  await test('locked transaction activity wins over candidate selection', async () => {
    const pool = await setup();
    const target = await user(pool);
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [target.userId]);
    const svc = createInactivityService({ pool, sendAlert: async () => true });
    const running = svc.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.query('UPDATE users SET last_transaction_activity_at=clock_timestamp() WHERE id=$1', [target.userId]);
    await client.query('COMMIT'); client.release();
    assert.equal((await running).created, 0);
  });

  await test('late keep before purge and expired auto purge with exact ownership cleanup', async () => {
    const pool = await setup();
    const target = await user(pool);
    const other = await user(pool, { recent: true });
    await pool.query("INSERT INTO transactions (user_id,type,amount,category) VALUES ($1,'expense',1,'test'),($2,'expense',1,'test')", [target.userId, other.userId]);
    await pool.query("INSERT INTO categories (user_id,name) VALUES ($1,'synthetic')", [target.userId]);
    await pool.query("INSERT INTO deletion_requests (request_code,user_id,request_type,requester_telegram_user_id,requester_chat_id,user_phone_number) VALUES ('synthetic',$1,'account',$2,$2,$3)", [target.userId, target.telegramUserId, target.phone]);
    await pool.query("INSERT INTO deletion_requests (request_code,user_id,request_type,requester_telegram_user_id,requester_chat_id) VALUES ('orphan',NULL,'account',$1,$1),('other-orphan',NULL,'account',$2,$2)", [target.telegramUserId, other.telegramUserId]);
    await pool.query("INSERT INTO otp_codes (phone_number,code_hash,expires_at) VALUES ($1,'x',NOW()+INTERVAL '1 hour'),($2,'y',NOW()+INTERVAL '1 hour')", [target.phone, other.phone]);
    await pool.query("INSERT INTO otp_codes (phone_number,code_hash,expires_at,user_id) VALUES ($1,'z',NOW()+INTERVAL '1 hour',$2),($1,'other',NOW()+INTERVAL '1 hour',$3)", [target.phone.slice(1), target.userId, other.userId]);
    let data; let invalidated;
    const svc = createInactivityService({ pool, sendAlert: async (m) => { data = m.reply_markup.inline_keyboard[0][0].callback_data; return true; }, invalidateCache: async (id) => { invalidated = id; } });
    await svc.runOnce();
    await pool.query("UPDATE inactivity_cases SET purge_after=clock_timestamp() WHERE user_id=$1", [target.userId]);
    assert.equal((await svc.runOnce()).purged, 0);
    assert.equal((await svc.handleCallback({ ...target, data })).outcome, 'kept');
    await pool.query("UPDATE users SET inactivity_enrolled_at=clock_timestamp()-INTERVAL '30 days' WHERE id=$1", [target.userId]);
    await svc.runOnce();
    await pool.query("UPDATE inactivity_cases SET purge_after=clock_timestamp() WHERE user_id=$1", [target.userId]);
    await drained(svc);
    assert.equal((await svc.runOnce()).purged, 1);
    assert.equal(invalidated, target.userId);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM users WHERE id=$1', [target.userId])).n, 0);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM transactions WHERE user_id=$1', [other.userId])).n, 1);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM deletion_requests')).n, 1);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM otp_codes WHERE phone_number=$1', [target.phone])).n, 0);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM otp_codes WHERE phone_number=$1', [other.phone])).n, 1);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM otp_codes WHERE phone_number=$1 AND user_id=$2', [target.phone.slice(1), other.userId])).n, 1);
  });

  await test('immediate delete, rollback on ambiguous phone and unknown FK', async () => {
    const pool = await setup();
    const target = await user(pool);
    const other = await user(pool, { recent: true });
    await pool.query('UPDATE telegram_accounts SET phone_number=$1 WHERE user_id=$2', [target.phone, other.userId]);
    await pool.query("INSERT INTO deletion_requests (request_code,user_id,request_type,requester_telegram_user_id,requester_chat_id) VALUES ('rollback',$1,'account',$2,$2)", [target.userId, target.telegramUserId]);
    let data;
    const svc = createInactivityService({ pool, sendAlert: async (m) => { data = m.reply_markup.inline_keyboard[0][1].callback_data; return true; } });
    await svc.runOnce();
    await assert.rejects(svc.handleCallback({ ...target, data }), /ambiguous/);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM deletion_requests WHERE user_id=$1', [target.userId])).n, 1);
    await pool.query('UPDATE telegram_accounts SET phone_number=$1 WHERE user_id=$2', [other.phone, other.userId]);
    await pool.query('CREATE TABLE unexpected_child (user_id UUID REFERENCES users(id) ON DELETE CASCADE)');
    await assert.rejects(svc.handleCallback({ ...target, data }), /unexpected foreign key/);
    await pool.query('DROP TABLE unexpected_child');
    await pool.query(`CREATE FUNCTION reject_synthetic_purge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic purge failure'; END $$`);
    await pool.query('CREATE TRIGGER reject_synthetic_purge BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION reject_synthetic_purge()');
    await assert.rejects(svc.handleCallback({ ...target, data }), /synthetic purge failure/);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM deletion_requests WHERE user_id=$1', [target.userId])).n, 1);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM inactivity_cases WHERE user_id=$1', [target.userId])).n, 1);
    await pool.query('DROP TRIGGER reject_synthetic_purge ON users');
    assert.equal((await svc.handleCallback({ ...target, data })).outcome, 'deleted');
    assert.equal((await svc.handleCallback({ ...target, data })).outcome, 'invalid');
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM users WHERE id=$1', [other.userId])).n, 1);
  });

  await test('concurrent callback deletion and expiry purge are idempotent', async () => {
    const pool = await setup();
    const target = await user(pool); let data;
    const svc = createInactivityService({ pool, sendAlert: async (m) => { data = m.reply_markup.inline_keyboard[0][1].callback_data; return true; } });
    await svc.runOnce();
    await pool.query('UPDATE inactivity_cases SET purge_after=clock_timestamp() WHERE user_id=$1', [target.userId]);
    await drained(svc);
    const [callback, worker] = await Promise.all([svc.handleCallback({ ...target, data }), svc.runOnce()]);
    assert.equal(Number(callback.outcome === 'deleted') + worker.purged, 1);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM users WHERE id=$1', [target.userId])).n, 0);
  });

  await test('one unsafe purge is retried without starving other users', async () => {
    const pool = await setup();
    const ambiguous = await user(pool);
    const good = await user(pool);
    const other = await user(pool, { recent: true });
    await pool.query('UPDATE telegram_accounts SET phone_number=$1 WHERE user_id=$2', [ambiguous.phone, other.userId]);
    const svc = createInactivityService({ pool, sendAlert: async () => true, retrySeconds: 60 });
    await svc.runOnce();
    await pool.query('UPDATE inactivity_cases SET purge_after=clock_timestamp()');
    await drained(svc);
    const result = await svc.runOnce();
    assert.equal(result.purgeFailures, 1);
    assert.equal(result.purged, 1);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM users WHERE id=$1', [good.userId])).n, 0);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM users WHERE id=$1', [ambiguous.userId])).n, 1);
    assert.ok((await one(pool, 'SELECT purge_retry_after > clock_timestamp() AS retry FROM inactivity_cases WHERE user_id=$1', [ambiguous.userId])).retry);
  });

  await test('poll watermark fails closed until a fresh post-deadline drained poll', async () => {
    const pool = await setup();
    const target = await user(pool);
    const svc = createInactivityService({ pool, sendAlert: async () => true });
    await svc.runOnce();
    await pool.query("UPDATE inactivity_cases SET purge_after=clock_timestamp()-INTERVAL '1 minute' WHERE user_id=$1", [target.userId]);
    assert.equal((await svc.runOnce()).purged, 0);
    await drained(svc);
    await pool.query("UPDATE inactivity_poll_health SET drained_at=clock_timestamp()-INTERVAL '3 minutes'");
    assert.equal((await svc.runOnce()).purged, 0);
    await pool.query("UPDATE inactivity_poll_health SET drained_at=clock_timestamp()-INTERVAL '2 seconds'");
    await pool.query("UPDATE inactivity_cases SET purge_after=clock_timestamp()-INTERVAL '1 second' WHERE user_id=$1", [target.userId]);
    assert.equal((await svc.runOnce()).purged, 0);
    const pending = await svc.beginPoll({ ownerId });
    assert.equal((await svc.runOnce()).purged, 0);
    assert.equal(await svc.confirmPollDrained({ ownerId, ...pending }), 'new');
    assert.equal((await svc.runOnce()).purged, 1);
  });

  await test('purgeEligible handles at most five and never sends alerts', async () => {
    const pool = await setup();
    for (let i = 0; i < 6; i++) await user(pool);
    let sends = 0;
    const svc = createInactivityService({ pool, sendAlert: async () => { sends++; return true; } });
    await svc.runOnce();
    assert.equal(sends, 6);
    await pool.query('UPDATE inactivity_cases SET purge_after=clock_timestamp()');
    await drained(svc);
    await assert.rejects(svc.purgeEligible({ limit: 6 }), /purge limit/);
    assert.equal((await svc.purgeEligible()).purged, 5);
    assert.equal(sends, 6);
    assert.equal((await svc.purgeEligible()).purged, 1);
  });

  await test('bootstrap reset invalidates both a heartbeat and an outstanding poll', async () => {
    const pool = await setup();
    const target = await user(pool);
    const svc = createInactivityService({ pool, sendAlert: async () => true });
    await svc.runOnce();
    await pool.query('UPDATE inactivity_cases SET purge_after=clock_timestamp() WHERE user_id=$1', [target.userId]);
    await drained(svc);
    const pending = await svc.beginPoll({ ownerId });
    await svc.resetPollingHealth();
    assert.equal(await svc.confirmPollDrained({ ownerId, ...pending }), false);
    const health = await one(pool, 'SELECT poll_token, poll_started_at, drained_at, confirmed_at, recovery_required FROM inactivity_poll_health WHERE id=TRUE');
    assert.deepEqual(health, { poll_token: null, poll_started_at: null, drained_at: null, confirmed_at: null, recovery_required: true });
    assert.equal((await svc.purgeEligible()).purged, 0);
    await drained(svc);
    assert.equal((await svc.purgeEligible()).purged, 0);
  });

  await test('unsafe polling is latched and blocks purge while allowing later polls', async () => {
    const pool = await setup();
    const target = await user(pool);
    const svc = createInactivityService({ pool, sendAlert: async () => true });
    await svc.runOnce();
    await pool.query('UPDATE inactivity_cases SET purge_after=clock_timestamp() WHERE user_id=$1', [target.userId]);
    const ownerId = randomBytes(16).toString('base64url');
    const { token } = await svc.beginPoll({ ownerId });
    assert.equal(await svc.markPollUnsafe({ ownerId, token }), 'new');
    assert.equal(await svc.markPollUnsafe({ ownerId, token }), 'duplicate');
    const next = await svc.beginPoll({ ownerId });
    assert.equal(await svc.confirmPollDrained({ ownerId, token: next.token }), 'new');
    assert.equal((await svc.purgeEligible()).purged, 0);
    assert.equal((await one(pool, 'SELECT recovery_required FROM inactivity_poll_health')).recovery_required, true);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM users WHERE id=$1', [target.userId])).n, 1);
  });

  await test('poll retries return the durable result without starting a second poll', async () => {
    const pool = await setup();
    const svc = createService({ pool, sendAlert: async () => true, autoPurgeEnabled: true });
    const ownerId = randomBytes(16).toString('base64url');
    const requestId = randomBytes(16).toString('base64url');
    const first = await svc.beginPoll({ ownerId, requestId });
    const retry = await svc.beginPoll({ ownerId, requestId });
    assert.equal(retry.token, first.token);
    assert.equal(retry.outcome, 'duplicate');
    assert.equal(await svc.confirmPollDrained({ ownerId, token: first.token }), 'new');
    assert.equal(await svc.confirmPollDrained({ ownerId, token: first.token }), 'duplicate');
    await assert.rejects(svc.beginPoll({ ownerId, requestId }), (error) => error.code === 'POLL_REQUEST_COMPLETED');
  });

  await test('poll owner fencing, nonempty batches and expired takeover fail closed', async () => {
    const pool = await setup();
    const target = await user(pool);
    const a = randomBytes(16).toString('base64url');
    const b = randomBytes(16).toString('base64url');
    const svc = createInactivityService({ pool, sendAlert: async () => true });
    await svc.runOnce();
    await pool.query('UPDATE inactivity_cases SET purge_after=clock_timestamp() WHERE user_id=$1', [target.userId]);
    const first = await svc.beginPoll({ ownerId: a });
    await assert.rejects(svc.beginPoll({ ownerId: b }), (error) => error.code === 'POLL_UNAVAILABLE');
    assert.equal(await svc.confirmPollDrained({ ownerId: b, token: first.token }), false);
    assert.equal(await svc.completePollBatch({ ownerId: a, token: first.token }), 'new');
    const next = await svc.beginPoll({ ownerId: a });
    await pool.query("UPDATE inactivity_poll_health SET owner_lease_until=clock_timestamp()-INTERVAL '1 second'");
    const takeover = await svc.beginPoll({ ownerId: b });
    assert.equal(await svc.confirmPollDrained({ ownerId: a, token: next.token }), false);
    assert.equal(await svc.confirmPollDrained({ ownerId: b, token: takeover.token }), 'new');
    assert.equal((await one(pool, 'SELECT recovery_required FROM inactivity_poll_health')).recovery_required, true);
    assert.equal((await svc.purgeEligible()).purged, 0);
    const again = await svc.beginPoll({ ownerId: b });
    assert.equal(await svc.completePollBatch({ ownerId: b, token: again.token }), 'new');
  });

  await test('unknown and stale durable polling latch recovery without stopping polling', async () => {
    const pool = await setup();
    const svc = createInactivityService({ pool, sendAlert: async () => true });
    await pool.query('UPDATE inactivity_poll_health SET last_durable_poll_at = NULL');
    await svc.resetPollingHealth();
    assert.equal((await one(pool, 'SELECT recovery_required FROM inactivity_poll_health')).recovery_required, false);
    await drained(svc);
    const target = await user(pool);
    await svc.runOnce();
    await pool.query("UPDATE inactivity_cases SET purge_after=clock_timestamp()-INTERVAL '1 hour' WHERE user_id=$1", [target.userId]);
    await pool.query("UPDATE inactivity_poll_health SET last_durable_poll_at=clock_timestamp()-INTERVAL '12 hours 1 second'");
    await drained(svc);
    assert.equal((await one(pool, 'SELECT recovery_required FROM inactivity_poll_health')).recovery_required, true);
    assert.equal((await svc.purgeEligible()).purged, 0);
    await svc.resetPollingHealth();
    await drained(svc);
    assert.equal((await one(pool, 'SELECT recovery_required FROM inactivity_poll_health')).recovery_required, true);
    assert.equal((await svc.purgeEligible()).purged, 0);

    const unknownPool = await setup();
    const unknownSvc = createInactivityService({ pool: unknownPool, sendAlert: async () => true });
    await user(unknownPool);
    await unknownSvc.runOnce();
    await unknownPool.query('UPDATE inactivity_poll_health SET last_durable_poll_at=NULL');
    await unknownSvc.resetPollingHealth();
    assert.equal((await one(unknownPool, 'SELECT recovery_required FROM inactivity_poll_health')).recovery_required, true);
    await drained(unknownSvc);
  });

  await test('status changes always prevent purge', async () => {
    const pool = await setup();
    for (const field of ['is_admin', 'is_blocked', 'is_deleted']) {
      const target = await user(pool); let data;
      const svc = createInactivityService({ pool, sendAlert: async (m) => { data = m.reply_markup.inline_keyboard[0][1].callback_data; return true; } });
      await svc.runOnce();
      await pool.query(`UPDATE users SET ${field}=TRUE WHERE id=$1`, [target.userId]);
      await pool.query('UPDATE inactivity_cases SET purge_after=clock_timestamp() WHERE user_id=$1', [target.userId]);
      assert.equal((await svc.handleCallback({ ...target, data })).outcome, 'invalid');
      await svc.runOnce();
      assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM users WHERE id=$1', [target.userId])).n, 1);
    }
  });
} finally {
  await cleanup();
}
