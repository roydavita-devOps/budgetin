// Opt-in only: node backend/test/inactivity-api.test.mjs
// Requires Docker, local postgres:16-alpine and redis:7-alpine, and backend dependencies.
// HTTP uses synthetic case state; worker tests inject an in-process fake Telegram sender.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rmdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suffix = randomBytes(12).toString('hex');
const password = randomBytes(24).toString('hex');
const botSecret = randomBytes(32).toString('hex');
const created = [];
let pool, server, tempDir, base;
let failures = 0;
let cleaning = false;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise((resolve) => {
      server.once('exit', resolve);
      server.kill();
      setTimeout(resolve, 3000).unref();
    });
  }
  if (pool) await pool.end().catch(() => {});
  for (const name of created.reverse()) {
    try { docker('rm', '-f', '-v', name); } catch (error) { failures++; console.error(`FAIL cleanup ${name}: ${error.message}`); }
  }
  if (tempDir) await rmdir(tempDir);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { cleanup().finally(() => process.exit(130)); });
}

async function eventually(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { return await fn(); } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error(`${label} tidak siap: ${lastError?.message}`);
}

function startContainer(name, ...args) {
  docker('run', '-d', '--pull=never', '--name', name, '--label', `budgetin.inactivity-test=${suffix}`, ...args);
  created.push(name);
}

function publishedPort(name, port) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', name, `${port}/tcp`));
  assert.ok(match, 'Container harus terikat hanya pada loopback');
  return Number(match[1]);
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// Loaded before server imports: permit outbound TCP only to the two disposable containers.
// DNS lookups and subprocess creation are denied. Telegram cannot reach the network.
function networkGuard(ports) {
  const source = `
    import net from 'node:net';
    import dns from 'node:dns';
    import child from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const allowed = new Set(${JSON.stringify(ports)});
    const connect = net.Socket.prototype.connect;
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function(...args) {
      if (typeof args[0] === 'number') args.splice(1, 0, '127.0.0.1');
      else if (args[0] && typeof args[0] === 'object' && 'port' in args[0]) args[0] = { ...args[0], host: '127.0.0.1' };
      else throw new Error('inactivity QA: unsupported listener');
      return listen.apply(this, args);
    };
    net.Socket.prototype.connect = function(...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      const options = typeof first === 'object' && first !== null ? first : { port: first, host: args[1] };
      if (options.host !== '127.0.0.1' || !allowed.has(Number(options.port)) || options.path) {
        throw new Error('inactivity QA: outbound connection blocked');
      }
      return connect.apply(this, args);
    };
    const lookup = dns.lookup;
    dns.lookup = function(host, ...args) {
      if (host !== '127.0.0.1') throw new Error('inactivity QA: DNS blocked');
      return lookup.call(this, host, ...args);
    };
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      child[name] = () => { throw new Error('inactivity QA: subprocess blocked'); };
    }
    syncBuiltinESMExports();
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function request(route, { method = 'GET', body, bot = true, botToken = botSecret, token } = {}) {
  if (route === '/telegram/inactivity/poll-begin' && body && !body.requestId) {
    body = { ...body, requestId: randomBytes(16).toString('base64url') };
  }
  const headers = {};
  if (bot) headers['x-bot-token'] = botToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${route}`, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

async function check(label, fn) {
  try {
    const result = await fn();
    console.log(`${result === 'skip' ? 'SKIP' : 'PASS'} ${label}`);
  }
  catch (error) { failures++; console.error(`FAIL ${label}: ${error.stack}`); }
}

async function main() {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'budgetin-inactivity-'));
  const pgName = `budgetin-inactivity-pg-${suffix}`;
  const redisName = `budgetin-inactivity-redis-${suffix}`;
  startContainer(pgName, '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_USER=integration', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=integration', 'postgres:16-alpine');
  startContainer(redisName, '--tmpfs', '/data:rw,noexec,nosuid,size=32m', '-p', '127.0.0.1::6379', 'redis:7-alpine',
    'redis-server', '--save', '', '--appendonly', 'no');
  const pgPort = publishedPort(pgName, 5432);
  const redisPort = publishedPort(redisName, 6379);
  pool = new pg.Pool({ connectionString: `postgres://integration:${password}@127.0.0.1:${pgPort}/integration`, connectionTimeoutMillis: 1000 });
  await eventually(() => pool.query('SELECT 1'), 'PostgreSQL');
  await pool.query(await readFile(path.join(root, 'database/init/001_schema.sql'), 'utf8'));

  // This row predates server startup, migrations and any new enrolment integration.
  const legacy = (await pool.query("INSERT INTO users (phone_number, created_at) VALUES ('+628111000002', NOW() - INTERVAL '2 years') RETURNING id")).rows[0];
  const { createInactivityService: createService } = await import('../src/inactivity.js');
  const createInactivityService = (options) => {
    const service = createService({ autoPurgeEnabled: true, ...options });
    return {
      ...service,
      beginPoll: (args) => service.beginPoll({ requestId: randomBytes(16).toString('base64url'), ...args }),
      confirmPollDrained: async (args) => (await service.confirmPollDrained(args)) === 'new',
      completePollBatch: async (args) => (await service.completePollBatch(args)) === 'new',
    };
  };
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'production', TZ: 'UTC', DOTENV_CONFIG_PATH: path.join(tempDir, 'nonexistent.env'),
    DATABASE_URL: `postgres://integration:${password}@127.0.0.1:${pgPort}/integration`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, JWT_SECRET: randomBytes(32).toString('hex'),
    BOT_INTERNAL_TOKEN: botSecret, TELEGRAM_BOT_TOKEN: '', COOKIE_SECURE: 'false', PORT: String(port),
    INACTIVITY_AUTO_ENABLED: 'true', INACTIVITY_AUTO_PURGE_ENABLED: 'true',
  };
  const guard = networkGuard([pgPort, redisPort]);
  const probe = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e',
    "import net from 'node:net'; try { net.connect(443, '1.1.1.1'); process.exit(1); } catch (e) { if (!e.message.includes('outbound connection blocked')) process.exit(2); }"] , { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(probe.status, 0, `Outbound guard gagal: ${probe.stderr}`);
  console.log('PASS outbound TCP guard menolak alamat eksternal');
  let output = '';
  server = spawn(process.execPath, ['--import', guard, 'src/server.js'], { cwd: path.join(root, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', (error) => { output += error.message; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-6000); });
  await eventually(async () => {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Server berhenti: ${output}`);
    assert.ok(output.includes(`Budgetin API listening on ${port}`), 'Server sintetis belum listen');
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
  }, 'Backend');

  const contact = (phone, id) => request('/telegram/contact', { method: 'POST', body: {
    phone_number: phone, telegram_user_id: id, telegram_chat_id: id, first_name: 'Synthetic',
  } });
  let fresh;
  await check('registrasi baru dan pengulangan memakai user yang sama', async () => {
    const first = await contact('+628111000001', '81000001');
    assert.equal(first.status, 201);
    assert.equal(first.data.is_new_registration, true);
    fresh = first.data.user.id;
    assert.ok((await pool.query('SELECT inactivity_enrolled_at FROM users WHERE id = $1', [fresh])).rows[0].inactivity_enrolled_at);
    const repeat = await contact('+628111000001', '81000001');
    assert.equal(repeat.status, 200);
    assert.equal(repeat.data.user.id, fresh);
    assert.equal(repeat.data.is_new_registration, false);
  });
  await check('penghubungan akun lama tidak membuat user baru', async () => {
    const result = await contact('+628111000002', '81000002');
    assert.equal(result.status, 201);
    assert.equal(result.data.user.id, legacy.id);
    assert.equal((await pool.query('SELECT inactivity_enrolled_at FROM users WHERE id = $1', [legacy.id])).rows[0].inactivity_enrolled_at, null);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM users WHERE phone_number = '+628111000002'")).rows[0].count, 1);
  });
  await check('guard bot dan private chat menolak request', async () => {
    assert.equal((await request('/telegram/contact', { method: 'POST', bot: false, body: { phone_number: '+628111000003', telegram_user_id: '81000003', telegram_chat_id: '81000003' } })).status, 401);
    assert.equal((await request('/telegram/contact', { method: 'POST', body: { phone_number: '+628111000003', telegram_user_id: '81000003', telegram_chat_id: '-100123' } })).status, 400);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM users WHERE phone_number = '+628111000003'")).rows[0].count, 0);
  });
  await check('transaksi invalid tidak tersimpan, transaksi valid tersimpan sekali', async () => {
    assert.ok(fresh, 'Registrasi baru gagal');
    await pool.query("UPDATE users SET last_transaction_activity_at = '2020-01-01T00:00:00Z' WHERE id = $1", [fresh]);
    const body = { telegram_user_id: '81000001', type: 'expense', amount: 0, category: 'food_drink' };
    assert.equal((await request('/telegram/transactions', { method: 'POST', body })).status, 400);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM transactions WHERE user_id = $1', [fresh])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT last_transaction_activity_at FROM users WHERE id = $1', [fresh])).rows[0].last_transaction_activity_at.toISOString(), '2020-01-01T00:00:00.000Z');
    assert.equal((await request('/telegram/transactions', { method: 'POST', body: { ...body, amount: 1000 } })).status, 201);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM transactions WHERE user_id = $1', [fresh])).rows[0].count, 1);
    assert.ok((await pool.query('SELECT last_transaction_activity_at > now() - interval \'1 minute\' AS recent FROM users WHERE id = $1', [fresh])).rows[0].recent);
  });
  let fixtureNumber = 10;
  async function fixture({ admin = false, linked = true } = {}) {
    const n = fixtureNumber++;
    const telegram = String(81000000 + n);
    const phone = `+6281110000${String(n).padStart(2, '0')}`;
    const user = (await pool.query(`INSERT INTO users (email, phone_number, display_name, is_admin, inactivity_enrolled_at)
      VALUES ($1, $2, 'Synthetic PII', $3, clock_timestamp() - interval '31 days') RETURNING id`,
    [`synthetic-${n}@example.invalid`, phone, admin])).rows[0];
    if (linked) await pool.query(`INSERT INTO telegram_accounts (user_id, telegram_user_id, telegram_chat_id, phone_number, username)
      VALUES ($1, $2, $2, $3, 'synthetic-pii')`, [user.id, telegram, phone]);
    await pool.query("INSERT INTO transactions (user_id, type, amount, category, note) VALUES ($1, 'expense', 1, 'food_drink', 'synthetic-pii')", [user.id]);
    await pool.query("INSERT INTO otp_codes (phone_number, code_hash, expires_at) VALUES ($1, 'synthetic-pii', now() + interval '1 hour')", [phone]);
    await pool.query("INSERT INTO categories (user_id, name) VALUES ($1, 'synthetic-pii')", [user.id]);
    await pool.query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')", [user.id, `synthetic-${n}`]);
    await pool.query(`INSERT INTO deletion_requests (request_code, user_id, request_type, requester_telegram_user_id, requester_chat_id, user_phone_number, user_display_name)
      VALUES ($1, $2, 'account', $3, $3, $4, 'synthetic-pii')`, [`QA${n}`, user.id, telegram, phone]);
    return { id: user.id, telegram, phone, email: `synthetic-${n}@example.invalid` };
  }
  async function notified(user) {
    const token = randomBytes(16).toString('base64url');
    await pool.query(`INSERT INTO inactivity_cases (user_id, token, status, notified_at, purge_after)
      VALUES ($1, $2, 'notified', clock_timestamp(), clock_timestamp() + interval '48 hours')`, [user.id, token]);
    return token;
  }
  const respond = (user, action, token, bot = true) => request('/telegram/inactivity/response', {
    method: 'POST', bot, body: { telegram_user_id: user.telegram, action, token },
  });
  async function assertPresent(user, present) {
    const result = await pool.query(`SELECT
      (SELECT count(*)::int FROM users WHERE id = $1 OR email = $3 OR phone_number = $2) AS users,
      (SELECT count(*)::int FROM telegram_accounts WHERE user_id = $1 OR phone_number = $2) AS telegram,
      (SELECT count(*)::int FROM transactions WHERE user_id = $1) AS transactions,
      (SELECT count(*)::int FROM otp_codes WHERE phone_number = $2) AS otp,
      (SELECT count(*)::int FROM categories WHERE user_id = $1) AS categories,
      (SELECT count(*)::int FROM refresh_tokens WHERE user_id = $1) AS sessions,
      (SELECT count(*)::int FROM deletion_requests WHERE user_id = $1 OR user_phone_number = $2) AS requests,
      (SELECT count(*)::int FROM inactivity_cases WHERE user_id = $1) AS cases`, [user.id, user.phone, user.email]);
    const count = Number(present);
    const { cases, ...records } = result.rows[0];
    assert.deepEqual(records, { users: count, telegram: count, transactions: count, otp: count, categories: count, sessions: count, requests: count });
    if (!present) assert.equal(cases, 0);
  }
  await check('callback menjaga pemilik, secret, token dan replay; keep reset activity', async () => {
    const owner = await fixture();
    const other = await fixture();
    const token = await notified(owner);
    assert.equal((await respond(owner, 'keep', token, false)).status, 401);
    assert.equal((await respond(other, 'keep', token)).status, 409);
    assert.equal((await respond(owner, 'keep', randomBytes(16).toString('base64url'))).status, 409);
    assert.equal((await respond(owner, 'invalid', token)).status, 400);
    await assertPresent(owner, true);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM inactivity_cases WHERE user_id = $1', [owner.id])).rows[0].count, 1);
    assert.equal((await respond(owner, 'keep', token)).status, 200);
    assert.equal((await respond(owner, 'keep', token)).status, 409);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM inactivity_cases WHERE user_id = $1', [owner.id])).rows[0].count, 0);
    assert.ok((await pool.query("SELECT inactivity_enrolled_at > now() - interval '1 minute' AS recent FROM users WHERE id = $1", [owner.id])).rows[0].recent);
    // Prevent the unrelated account from becoming a candidate in subsequent worker tests.
    await pool.query('UPDATE users SET inactivity_enrolled_at = now() WHERE id = $1', [other.id]);
  });
  await check('delete HTTP menghapus data sintetis dan menolak replay', async () => {
    const user = await fixture();
    const token = await notified(user);
    assert.equal((await respond(user, 'delete', token)).status, 200);
    await assertPresent(user, false);
    assert.equal((await respond(user, 'delete', token)).status, 409);
  });
  await check('keep dan delete bersamaan menghasilkan satu keputusan konsisten', async () => {
    const user = await fixture();
    const token = await notified(user);
    const [keep, remove] = await Promise.all([respond(user, 'keep', token), respond(user, 'delete', token)]);
    if (keep.status === 200 || remove.status === 200) await assertPresent(user, keep.status === 200);
    assert.deepEqual([keep.status, remove.status].sort(), [200, 409]);
  });
  let pollHttpAvailable = false;
  const ownerId = randomBytes(16).toString('base64url');
  const otherOwnerId = randomBytes(16).toString('base64url');
  await check('endpoint poll heartbeat dilindungi bot token dan replay idempoten', async () => {
    const begin = '/telegram/inactivity/poll-begin';
    const drained = '/telegram/inactivity/poll-drained';
    const complete = '/telegram/inactivity/poll-complete';
    const requestId = randomBytes(16).toString('base64url');
    const probe = await request(begin, { method: 'POST', body: { ownerId, requestId } });
    if (probe.status === 404) {
      return 'skip';
    }
    assert.equal(probe.status, 200);
    assert.match(probe.data.token, /^[A-Za-z0-9_-]{22}$/);
    const repeatedBegin = await request(begin, { method: 'POST', body: { ownerId, requestId } });
    assert.equal(repeatedBegin.status, 200);
    assert.equal(repeatedBegin.data.token, probe.data.token);
    assert.equal((await request(begin, { method: 'POST', bot: false, body: { ownerId } })).status, 401);
    assert.equal((await request(drained, { method: 'POST', bot: false, body: { ownerId, token: probe.data.token } })).status, 401);
    assert.equal((await request(complete, { method: 'POST', bot: false, body: { ownerId, token: probe.data.token } })).status, 401);
    assert.equal((await request(begin, { method: 'POST', botToken: 'incorrect', body: { ownerId } })).status, 401);
    assert.equal((await request(drained, { method: 'POST', botToken: 'incorrect', body: { ownerId, token: probe.data.token } })).status, 401);
    assert.equal((await request(complete, { method: 'POST', botToken: 'incorrect', body: { ownerId, token: probe.data.token } })).status, 401);
    const takeover = await request(begin, { method: 'POST', body: { ownerId: otherOwnerId } });
    assert.ok(takeover.status >= 400, `Takeover poll aktif: ${takeover.status}`);
    const wrong = await request(drained, { method: 'POST', body: { ownerId, token: randomBytes(16).toString('base64url') } });
    assert.ok(wrong.status >= 400 && wrong.status < 500, `Token salah: ${wrong.status}`);
    const hijack = await request(drained, { method: 'POST', body: { ownerId: otherOwnerId, token: probe.data.token } });
    assert.ok(hijack.status >= 400 && hijack.status < 500, `Owner salah: ${hijack.status}`);
    const hijackComplete = await request(complete, { method: 'POST', body: { ownerId: otherOwnerId, token: probe.data.token } });
    assert.ok(hijackComplete.status >= 400 && hijackComplete.status < 500, `Owner salah: ${hijackComplete.status}`);
    const valid = await request(drained, { method: 'POST', body: { ownerId, token: probe.data.token } });
    assert.ok(valid.status >= 200 && valid.status < 300, `Drained sah: ${valid.status}`);
    const replay = await request(drained, { method: 'POST', body: { ownerId, token: probe.data.token } });
    assert.equal(replay.status, 200, `Replay: ${replay.status}`);
    pollHttpAvailable = true;
  });
  await check('worker fake: gagal kirim tidak menghapus; kirim sukses mulai deadline 48 jam', async () => {
    const user = await fixture();
    const admin = await fixture({ admin: true });
    const unlinked = await fixture({ linked: false });
    await pool.query("UPDATE users SET inactivity_enrolled_at = now() - interval '90 days' WHERE id = ANY($1::uuid[])", [[user.id, unlinked.id]]);
    const sent = [];
    let delivered = false;
    const worker = createInactivityService({ pool, sendAlert: async (message) => { sent.push(message); return delivered; } });
    await pool.query('UPDATE inactivity_poll_health SET poll_token = NULL, poll_started_at = NULL, drained_at = NULL, confirmed_at = NULL, owner_id = NULL, owner_lease_until = NULL, recovery_required = FALSE WHERE id = TRUE');
    await worker.runOnce();
    let item = (await pool.query('SELECT status, notified_at, purge_after FROM inactivity_cases WHERE user_id = $1', [user.id])).rows[0];
    assert.equal(item.status, 'pending');
    assert.equal(item.notified_at, null);
    assert.equal(item.purge_after, null);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM inactivity_cases WHERE user_id = $1', [admin.id])).rows[0].count, 0);
    assert.ok(!sent.some((message) => message.telegramUserId === admin.telegram));
    assert.ok(!sent.some((message) => message.telegramUserId === unlinked.telegram));
    await pool.query("UPDATE inactivity_cases SET retry_after = now() - interval '49 hours' WHERE user_id = $1", [user.id]);
    await worker.runOnce();
    await assertPresent(user, true);
    delivered = true;
    await pool.query("UPDATE inactivity_cases SET retry_after = now() - interval '1 second' WHERE user_id = $1", [user.id]);
    await worker.runOnce();
    item = (await pool.query('SELECT status, notified_at, purge_after FROM inactivity_cases WHERE user_id = $1', [user.id])).rows[0];
    assert.equal(item.status, 'notified');
    assert.ok(Math.abs(item.purge_after - item.notified_at - 48 * 60 * 60 * 1000) < 1000);
    await worker.runOnce();
    await assertPresent(user, true);
    // Backdate both timestamps to model 48 hours without changing the system clock.
    await pool.query("UPDATE inactivity_cases SET notified_at = now() - interval '49 hours', purge_after = now() - interval '1 hour' WHERE user_id = $1", [user.id]);
    let result = await worker.runOnce();
    assert.equal(result.purged, 0);
    assert.equal(result.purgeFailures, 0);
    assert.ok(result.purgeDeferred >= 1);
    await assertPresent(user, true);

    const early = await worker.beginPoll({ ownerId });
    assert.equal(await worker.confirmPollDrained({ ...early, ownerId }), true);
    // Model a recently confirmed poll that started before this case's deadline.
    await pool.query("UPDATE inactivity_poll_health SET drained_at = now() - interval '2 seconds', confirmed_at = now() - interval '1 second' WHERE id = TRUE");
    await pool.query("UPDATE inactivity_cases SET purge_after = now() - interval '1 second' WHERE user_id = $1", [user.id]);
    result = await worker.runOnce();
    assert.equal(result.purged, 0);
    assert.equal(result.purgeFailures, 0);
    await assertPresent(user, true);

    const pending = await worker.beginPoll({ ownerId });
    assert.equal(await worker.confirmPollDrained({ ownerId, token: randomBytes(16).toString('base64url') }), false);
    assert.equal(await worker.confirmPollDrained({ ownerId: otherOwnerId, token: pending.token }), false);
    await assert.rejects(worker.beginPoll({ ownerId: otherOwnerId }), { code: 'POLL_UNAVAILABLE' });
    result = await worker.runOnce();
    assert.equal(result.purged, 0);
    assert.equal(result.purgeFailures, 0);
    await assertPresent(user, true);
    assert.equal(await worker.confirmPollDrained({ ...pending, ownerId }), true);
    assert.equal(await worker.confirmPollDrained({ ...pending, ownerId }), false);
    // An expired heartbeat must not authorize deletion, even when the poll was drained.
    await pool.query("UPDATE inactivity_poll_health SET drained_at = now() - interval '3 minutes', confirmed_at = now() - interval '3 minutes' WHERE id = TRUE");
    result = await worker.runOnce();
    assert.equal(result.purged, 0);
    assert.equal(result.purgeFailures, 0);
    await assertPresent(user, true);
    const previouslyDrained = await worker.beginPoll({ ownerId });
    assert.equal(await worker.confirmPollDrained({ ...previouslyDrained, ownerId }), true);
    const outstanding = await worker.beginPoll({ ownerId });
    assert.equal(await worker.confirmPollDrained({ ...previouslyDrained, ownerId }), false);
    result = await worker.runOnce();
    assert.equal(result.purged, 0);
    assert.equal(result.purgeFailures, 0);
    await assertPresent(user, true);
    assert.equal(await worker.completePollBatch({ ...outstanding, ownerId }), true);
    let freshPoll;
    if (pollHttpAvailable) {
      const start = await request('/telegram/inactivity/poll-begin', { method: 'POST', body: { ownerId } });
      assert.equal(start.status, 200);
      freshPoll = { token: start.data.token, ownerId };
    } else {
      freshPoll = { ...await worker.beginPoll({ ownerId }), ownerId };
      console.log('SKIP heartbeat HTTP untuk purge: memakai fake service langsung');
    }
    assert.equal(await worker.confirmPollDrained({ ...outstanding, ownerId }), false);
    const started = await pool.query(`SELECT c.purge_after, h.poll_started_at > c.purge_after AS valid
      FROM inactivity_poll_health h JOIN inactivity_cases c ON c.user_id = $1
      WHERE h.id = TRUE AND h.poll_token = $2`, [user.id, freshPoll.token]);
    assert.equal(started.rows[0]?.valid, true);
    await assertPresent(user, true);
    if (pollHttpAvailable) {
      const done = await request('/telegram/inactivity/poll-drained', { method: 'POST', body: freshPoll });
      assert.ok(done.status >= 200 && done.status < 300);
    } else {
      assert.equal(await worker.confirmPollDrained(freshPoll), true);
    }
    const health = await pool.query(`SELECT drained_at > $1 AND confirmed_at >= drained_at AND poll_token IS NULL AS valid
      FROM inactivity_poll_health WHERE id = TRUE`, [started.rows[0].purge_after]);
    assert.equal(health.rows[0]?.valid, true);
    result = await worker.runOnce();
    assert.equal(result.purged, pollHttpAvailable ? 0 : 1);
    assert.equal(result.purgeFailures, 0);
    await assertPresent(user, false);
    await assertPresent(admin, true);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM users WHERE id = $1', [unlinked.id])).rows[0].count, 1);
  });
  await check('callback keep tertunda tetap memulihkan akun sebelum inbox dikonfirmasi kosong', async () => {
    const user = await fixture();
    const token = await notified(user);
    await pool.query("UPDATE inactivity_cases SET notified_at = now() - interval '49 hours', purge_after = now() - interval '1 hour' WHERE user_id = $1", [user.id]);
    await pool.query('UPDATE inactivity_poll_health SET poll_token = NULL, poll_started_at = NULL, drained_at = NULL, confirmed_at = NULL, owner_id = NULL, owner_lease_until = NULL, recovery_required = FALSE WHERE id = TRUE');
    const worker = createInactivityService({ pool, sendAlert: async () => false });
    const poll = await worker.beginPoll({ ownerId });
    const before = await worker.runOnce();
    assert.equal(before.purged, 0);
    assert.equal(before.purgeFailures, 0);
    await assertPresent(user, true);
    assert.equal((await respond(user, 'keep', token)).status, 200);
    assert.equal(await worker.confirmPollDrained({ ...poll, ownerId }), true);
    const after = await worker.runOnce();
    assert.equal(after.purgeFailures, 0);
    await assertPresent(user, true);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM inactivity_cases WHERE user_id = $1', [user.id])).rows[0].count, 0);
  });
  await check('takeover setelah lease habis tetap fail-closed saat poll lama belum selesai', async () => {
    const user = await fixture();
    await notified(user);
    await pool.query("UPDATE inactivity_cases SET notified_at = now() - interval '49 hours', purge_after = now() - interval '1 hour' WHERE user_id = $1", [user.id]);
    await pool.query('UPDATE inactivity_poll_health SET poll_token = NULL, poll_started_at = NULL, drained_at = NULL, confirmed_at = NULL, owner_id = NULL, owner_lease_until = NULL, recovery_required = FALSE WHERE id = TRUE');
    const worker = createInactivityService({ pool, sendAlert: async () => false });
    const initial = await worker.beginPoll({ ownerId });
    assert.equal(await worker.confirmPollDrained({ ...initial, ownerId }), true);
    await pool.query("UPDATE inactivity_poll_health SET owner_lease_until = now() - interval '1 second' WHERE id = TRUE");
    const expired = await worker.runOnce();
    assert.equal(expired.purged, 0);
    assert.equal(expired.purgeFailures, 0);
    assert.ok(expired.purgeDeferred >= 1);
    await assertPresent(user, true);
    const old = await worker.beginPoll({ ownerId });
    await assert.rejects(worker.beginPoll({ ownerId: otherOwnerId }), { code: 'POLL_UNAVAILABLE' });
    await pool.query("UPDATE inactivity_poll_health SET owner_lease_until = now() - interval '1 second' WHERE id = TRUE");
    const replacement = await worker.beginPoll({ ownerId: otherOwnerId });
    assert.equal(await worker.confirmPollDrained({ ...old, ownerId }), false);
    assert.equal(await worker.confirmPollDrained({ ...replacement, ownerId: otherOwnerId }), true);
    const health = await pool.query('SELECT recovery_required FROM inactivity_poll_health WHERE id = TRUE');
    assert.equal(health.rows[0].recovery_required, true);
    const result = await worker.runOnce();
    assert.equal(result.purged, 0);
    assert.equal(result.purgeFailures, 0);
    assert.ok(result.purgeDeferred >= 1);
    await assertPresent(user, true);
  });
  await check('Redis sintetis terhubung tanpa pelanggaran guard', async () => {
    assert.ok(!/Redis (?:error|connect failed)|OTP rate limit Redis (?:error|connect failed)|inactivity QA: outbound connection blocked/.test(output), output);
  });
  if (failures || server.exitCode !== null || server.signalCode !== null) console.error(`Log backend sintetis: ${output}`);
  console.log('SKIP private-chat boundary bot dan race worker lainnya: lihat inactivity-test-plan.md');
}

if (process.env.NODE_TEST_CONTEXT) {
  console.log('SKIP inactivity sidecar: jalankan langsung, bukan via node --test');
} else {
  try { await main(); }
  catch (error) { failures++; console.error(`FAIL setup: ${error.stack}`); }
  finally { await cleanup(); }
  process.exitCode = failures ? 1 : 0;
}
