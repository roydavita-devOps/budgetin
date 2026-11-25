// Opt-in: node backend/test/qa-p0-sidecar.mjs (Docker, local postgres:16-alpine
// and redis:7-alpine images, and installed backend dependencies required).
// Never reads database URLs or .env; only disposable, loopback-only containers.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suffix = randomBytes(8).toString('hex');
const names = [`budgetin-p0-pg-${suffix}`, `budgetin-p0-redis-${suffix}`];
const password = randomBytes(24).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const botSecret = randomBytes(32).toString('hex');
let pool, server, base, serverEnv;
let cleaning = false;
let failures = 0;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 3000).unref();
  });
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  await stopServer();
  if (pool) await pool.end().catch(() => {});
  for (const name of names) {
    try { docker('rm', '-f', '-v', name); } catch { /* Container may not exist. */ }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { cleanup().finally(() => process.exit(130)); });
}

async function eventually(fn, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { return await fn(); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error(`${label} tidak siap`);
}

function publishedPort(name, port) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', name, `${port}/tcp`));
  assert.ok(match, 'Container harus terikat ke loopback');
  return Number(match[1]);
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startServer() {
  let ready = false;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(root, 'backend'), env: { ...serverEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  server.on('error', () => {});
  server.stdout.on('data', (chunk) => { if (String(chunk).includes(`Budgetin API listening on ${port}`)) ready = true; });
  await eventually(async () => {
    if (!ready || server.exitCode !== null) throw new Error('Backend belum siap');
    if (!(await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) throw new Error('Health gagal');
  }, 'Backend');
}

async function request(route, { token, bot = false, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (bot) headers['x-bot-token'] = botSecret;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${route}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

async function check(label, fn) {
  try { await fn(); console.log(`PASS ${label}`); }
  catch (error) { failures++; console.error(`FAIL ${label}: ${error.message}`); }
}

async function main() {
  docker('run', '-d', '--pull=never', '--name', names[0], '--label', 'budgetin.integration=temporary',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_USER=integration', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=integration', 'postgres:16-alpine');
  docker('run', '-d', '--pull=never', '--name', names[1], '--label', 'budgetin.integration=temporary',
    '--tmpfs', '/data:rw,noexec,nosuid,size=32m', '-p', '127.0.0.1::6379', 'redis:7-alpine',
    'redis-server', '--save', '', '--appendonly', 'no');
  const databaseUrl = `postgres://integration:${password}@127.0.0.1:${publishedPort(names[0], 5432)}/integration`;
  const redisUrl = `redis://127.0.0.1:${publishedPort(names[1], 6379)}`;
  pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1000 });
  await eventually(() => pool.query('SELECT 1'), 'Postgres');
  await pool.query(await readFile(path.join(root, 'database/init/001_schema.sql'), 'utf8'));
  serverEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'production', TZ: 'UTC', DOTENV_CONFIG_PATH: path.join(root, `integration-no-env-${suffix}`),
    DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, JWT_SECRET: jwtSecret, BOT_INTERNAL_TOKEN: botSecret,
    TELEGRAM_BOT_TOKEN: '', COOKIE_SECURE: 'false',
  };
  await startServer();

  async function account(name, admin = false) {
    const result = await request('/auth/register', { method: 'POST', body: { email: `${name}@example.invalid`, password: 'synthetic-test-password' } });
    assert.equal(result.status, 201);
    const id = result.data.user.id;
    await pool.query('UPDATE users SET is_verified = true, is_admin = $2 WHERE id = $1', [id, admin]);
    await pool.query('INSERT INTO telegram_accounts (user_id, telegram_user_id, telegram_chat_id, phone_number) VALUES ($1, $2, $3, $4)',
      [id, name, `chat-${name}`, `synthetic-${name}`]);
    return { id, token: result.data.token, telegram: name };
  }
  const admin = await account('p0-admin', true);
  const a = await account('p0-a');
  const b = await account('p0-b');
  const c = await account('p0-c');
  const d = await account('p0-d');
  const bulk = await account('p0-bulk');
  const concurrent = await account('p0-concurrent');
  const recovery = await account('p0-recovery');
  const recoveryRace = await account('p0-recovery-race');
  const restoreValid = await account('p0-restore-valid');
  const restoreExpired = await account('p0-restore-expired');
  const restoreUnknown = await account('p0-restore-unknown');
  const restoreWait = await account('p0-restore-wait');
  const dates = await account('p0-dates');

  async function newRequest(user, type = 'account') {
    const result = await request('/telegram/deletion-requests', { method: 'POST', bot: true, body: { telegram_user_id: user.telegram, request_type: type } });
    assert.equal(result.status, 201);
    return result.data.request.request_code;
  }
  const confirm = (user, code) => request(`/telegram/deletion-requests/${code}`, {
    method: 'PATCH', bot: true, body: { telegram_user_id: user.telegram, action: 'confirm' },
  });
  const decide = (code, action) => request(`/telegram/admin/deletion-requests/${code}`, {
    method: 'PATCH', bot: true, body: { admin_telegram_user_id: admin.telegram, action },
  });
  async function state(user, code) {
    const result = await pool.query(`SELECT u.is_deleted, u.is_blocked, r.status, r.processed_at
      FROM users u JOIN deletion_requests r ON r.user_id = u.id WHERE u.id = $1 AND r.request_code = $2`, [user.id, code]);
    assert.equal(result.rowCount, 1);
    return result.rows[0];
  }
  async function injectFailure(table, column, user, code, operation) {
    // Trigger is installed only in this runner's newly created database.
    await pool.query(`CREATE OR REPLACE FUNCTION qa_p0_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic p0 failure'; END $$`);
    const target = table === 'users' ? user.id : code;
    // Parameters cannot be used in CREATE TRIGGER; identifiers and value are generated by this test.
    assert.match(target, /^[a-zA-Z0-9-]+$/);
    await pool.query(`CREATE TRIGGER qa_p0_fail BEFORE UPDATE OF ${column} ON ${table}
      FOR EACH ROW WHEN (OLD.${table === 'users' ? 'id::text' : 'request_code'} = '${target}') EXECUTE FUNCTION qa_p0_fail()`);
    let result;
    try { result = await operation().catch(() => null); }
    finally { await pool.query(`DROP TRIGGER qa_p0_fail ON ${table}`); }
    assert.equal(result?.status, 500, 'Kegagalan database harus menghasilkan respons 500 tanpa mematikan server');
    const actual = await state(user, code);
    assert.equal(actual.status, 'pending', 'Permintaan harus tetap pending setelah rollback');
    assert.equal(actual.is_deleted, false, 'Akun tidak boleh terhapus setelah rollback');
    assert.equal(actual.is_blocked, false, 'Akun tidak boleh terblokir setelah rollback');
    assert.equal(actual.processed_at, null);
  }
  async function ensureServer() {
    if (server.exitCode !== null || server.signalCode !== null) await startServer();
  }
  async function overlapUpdates(code, operation) {
    assert.match(code, /^[a-zA-Z0-9-]+$/);
    await pool.query(`CREATE OR REPLACE FUNCTION qa_p0_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER qa_p0_pause BEFORE UPDATE OF status ON deletion_requests
      FOR EACH ROW WHEN (OLD.request_code = '${code}') EXECUTE FUNCTION qa_p0_pause()`);
    try { return await operation(); }
    finally { await pool.query('DROP TRIGGER qa_p0_pause ON deletion_requests'); }
  }

  await check('rollback konfirmasi jika update akun gagal', async () => {
    const code = await newRequest(a);
    await injectFailure('users', 'is_deleted', a, code, () => confirm(a, code));
  });
  await ensureServer();
  await check('rollback admin jika update permintaan gagal', async () => {
    const code = await newRequest(b);
    await injectFailure('deletion_requests', 'status', b, code, () => decide(code, 'approve'));
  });
  await ensureServer();

  await check('rollback admin mempertahankan transaksi ketika keputusan gagal', async () => {
    await pool.query("INSERT INTO transactions (user_id, type, amount, category, note) VALUES ($1, 'expense', 10, 'food_drink', 'synthetic')", [bulk.id]);
    const code = await newRequest(bulk, 'all_transactions');
    await injectFailure('deletion_requests', 'status', bulk, code, () => decide(code, 'approve'));
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM transactions WHERE user_id = $1', [bulk.id]);
    assert.equal(result.rows[0].count, 1);
  });

  await check('pembuatan permintaan bersamaan hanya membuat satu permintaan', async () => {
    const body = { telegram_user_id: concurrent.telegram, request_type: 'account' };
    const results = await Promise.all(Array.from({ length: 5 }, () => request('/telegram/deletion-requests', { method: 'POST', bot: true, body })));
    assert.equal(results.filter((r) => r.status === 201).length, 1, `Status: ${results.map((r) => r.status)}`);
    assert.equal(results.filter((r) => r.status === 409).length, 4, `Status: ${results.map((r) => r.status)}`);
    const result = await pool.query("SELECT COUNT(*)::int AS count FROM deletion_requests WHERE user_id = $1 AND request_type = 'account' AND status = 'pending'", [concurrent.id]);
    assert.equal(result.rows[0].count, 1);
  });

  await check('permintaan hapus transaksi tidak dijalankan saat akun dalam recovery', async () => {
    await pool.query("INSERT INTO transactions (user_id, type, amount, category, note) VALUES ($1, 'expense', 10, 'food_drink', 'recovery')", [recovery.id]);
    const bulkCode = await newRequest(recovery, 'all_transactions');
    const accountCode = await newRequest(recovery, 'account');
    assert.equal((await confirm(recovery, accountCode)).status, 200);
    assert.equal((await decide(bulkCode, 'approve')).status, 409);
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM transactions WHERE user_id = $1', [recovery.id]);
    assert.equal(result.rows[0].count, 1);
    assert.equal((await state(recovery, bulkCode)).status, 'pending');
  });

  await check('hapus akun dan seluruh transaksi bersamaan terserialisasi', async () => {
    await pool.query("INSERT INTO transactions (user_id, type, amount, category, note) VALUES ($1, 'expense', 10, 'food_drink', 'race')", [recoveryRace.id]);
    const bulkCode = await newRequest(recoveryRace, 'all_transactions');
    const accountCode = await newRequest(recoveryRace, 'account');
    const [accountResult, bulkResult] = await Promise.all([confirm(recoveryRace, accountCode), decide(bulkCode, 'approve')]);
    assert.equal(accountResult.status, 200);
    assert.ok([200, 409].includes(bulkResult.status), `Status: ${bulkResult.status}`);
    const count = (await pool.query('SELECT COUNT(*)::int AS count FROM transactions WHERE user_id = $1', [recoveryRace.id])).rows[0].count;
    assert.equal(count, bulkResult.status === 200 ? 0 : 1);
  });

  await check('pemulihan harus dalam tenggat dan verifikasi tidak memulihkan akun', async () => {
    await pool.query("UPDATE users SET is_deleted = TRUE, is_blocked = TRUE, delete_recovery_until = NOW() + INTERVAL '1 day' WHERE id = $1", [restoreValid.id]);
    await pool.query("UPDATE users SET is_deleted = TRUE, is_blocked = TRUE, delete_recovery_until = NOW() - INTERVAL '1 second' WHERE id = $1", [restoreExpired.id]);
    await pool.query('UPDATE users SET is_deleted = TRUE, is_blocked = TRUE, delete_recovery_until = NULL WHERE id = $1', [restoreUnknown.id]);
    const adminAction = (user, action) => request(`/telegram/admin/users/${user.telegram}`, {
      method: 'PATCH', bot: true, body: { admin_telegram_user_id: admin.telegram, action },
    });
    assert.equal((await adminAction(restoreValid, 'verify')).status, 409);
    assert.equal((await adminAction(restoreValid, 'block')).status, 409);
    assert.equal((await adminAction(restoreExpired, 'restore')).status, 409);
    assert.equal((await adminAction(restoreUnknown, 'restore')).status, 409);
    assert.equal((await adminAction(restoreValid, 'restore')).status, 200);
    const rows = await pool.query('SELECT id, is_deleted FROM users WHERE id = ANY($1::uuid[])', [[restoreValid.id, restoreExpired.id, restoreUnknown.id]]);
    const states = new Map(rows.rows.map((row) => [row.id, row.is_deleted]));
    assert.equal(states.get(restoreValid.id), false);
    assert.equal(states.get(restoreExpired.id), true);
    assert.equal(states.get(restoreUnknown.id), true);
  });

  await check('pemulihan ditolak bila tenggat lewat saat menunggu kunci', async () => {
    const lock = await pool.connect();
    let pending;
    try {
      await pool.query("UPDATE users SET is_deleted = TRUE, is_blocked = TRUE, delete_recovery_until = clock_timestamp() + INTERVAL '2 seconds' WHERE id = $1", [restoreWait.id]);
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [restoreWait.id]);
      pending = request(`/telegram/admin/users/${restoreWait.telegram}`, {
        method: 'PATCH', bot: true, body: { admin_telegram_user_id: admin.telegram, action: 'restore' },
      });
      await eventually(async () => {
        const result = await pool.query("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM users WHERE id = % FOR UPDATE'");
        assert.equal(result.rows[0].count, 1);
      }, 'Restore menunggu kunci', 1000);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      await lock.query('COMMIT');
    } finally {
      await lock.query('ROLLBACK').catch(() => {});
      lock.release();
    }
    assert.equal((await pending).status, 409);
    const result = await pool.query('SELECT is_deleted FROM users WHERE id = $1', [restoreWait.id]);
    assert.equal(result.rows[0].is_deleted, true);
  });

  await check('dua konfirmasi bersamaan hanya satu berhasil', async () => {
    const code = await newRequest(c);
    const results = await overlapUpdates(code, () => Promise.all([confirm(c, code), confirm(c, code)]));
    assert.equal(results.filter((r) => r.status === 200).length, 1, `Status: ${results.map((r) => r.status)}`);
    assert.ok(results.some((r) => [403, 409].includes(r.status)), `Status: ${results.map((r) => r.status)}`);
    const actual = await state(c, code);
    assert.equal(actual.status, 'approved');
    assert.equal(actual.is_deleted, true);
    assert.equal(actual.is_blocked, true);
  });

  await check('approve dan reject bersamaan menghasilkan satu keputusan konsisten', async () => {
    const code = await newRequest(d);
    const results = await overlapUpdates(code, () => Promise.all([decide(code, 'approve'), decide(code, 'reject')]));
    assert.equal(results.filter((r) => r.status === 200).length, 1, `Status: ${results.map((r) => r.status)}`);
    assert.ok(results.some((r) => r.status === 409), `Status: ${results.map((r) => r.status)}`);
    const actual = await state(d, code);
    assert.ok(['approved', 'rejected'].includes(actual.status));
    assert.equal(actual.is_deleted, actual.status === 'approved');
    assert.equal(actual.is_blocked, actual.status === 'approved');
  });

  await pool.query(`INSERT INTO transactions (user_id, type, amount, category, note, created_at) VALUES
    ($1, 'expense', 1, 'food_drink', 'before', '2024-02-28T16:59:59Z'),
    ($1, 'expense', 1, 'food_drink', 'leap-start', '2024-02-28T17:00:00Z'),
    ($1, 'expense', 1, 'food_drink', 'leap-end', '2024-02-29T16:59:59Z'),
    ($1, 'expense', 1, 'food_drink', 'after', '2024-02-29T17:00:00Z')`, [dates.id]);
  await check('filter hari kabisat inklusif pada batas WIB', async () => {
    const result = await request('/transactions?date=2024-02-29', { token: dates.token });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.data.map((row) => row.note), ['leap-end', 'leap-start']);
  });
  for (const filter of ['date=2023-02-29', 'date=1900-02-29', 'date=2024-04-31', 'date=2024-2-01', 'month=2024-13',
    'month=2024-00', 'date_from=2024-02-30', 'date_to=2024-02-30', 'date_from=2024-03-01&date_to=2024-02-29']) {
    await check(`filter tidak valid ditolak: ${filter}`, async () => {
      const result = await request(`/transactions?${filter}`, { token: dates.token });
      assert.equal(result.status, 400, `Diharapkan 400, diterima ${result.status}`);
    });
    await ensureServer();
  }
  for (const [route, options] of [
    ['/exports/transactions.csv?date=2023-02-29', { token: dates.token }],
    [`/telegram/transactions?telegram_user_id=${dates.telegram}&date=2023-02-29`, { bot: true }],
    [`/telegram/summary?telegram_user_id=${dates.telegram}&date=2023-02-29`, { bot: true }],
    [`/telegram/exports/transactions.csv?telegram_user_id=${dates.telegram}&date=2023-02-29`, { bot: true }],
  ]) {
    await check(`tanggal tidak valid ditolak: ${route.split('?')[0]}`, async () => {
      assert.equal((await request(route, options)).status, 400);
    });
    await ensureServer();
  }
  await check('tanggal kabisat abad yang valid diterima', async () => {
    assert.equal((await request('/transactions?date=2000-02-29', { token: dates.token })).status, 200);
  });
}

if (process.env.NODE_TEST_CONTEXT) {
  console.log('SKIP sidecar P0: jalankan qa-p0-sidecar.mjs secara langsung');
} else {
  try { await main(); }
  catch (error) { failures++; console.error(`FAIL setup: ${error.message}`); }
  finally { await cleanup(); }
  process.exitCode = failures ? 1 : 0;
}
