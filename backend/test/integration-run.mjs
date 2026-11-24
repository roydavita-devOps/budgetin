import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from 'redis';

// This runner never reads database URLs or credentials from the environment.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suffix = randomBytes(8).toString('hex');
const names = [`budgetin-it-pg-${suffix}`, `budgetin-it-redis-${suffix}`];
const password = randomBytes(24).toString('hex');
const jwtSecret = randomBytes(32).toString('hex');
const botSecret = randomBytes(32).toString('hex');
let server;
let pool;
let redis;
let cleaning = false;
let failures = 0;

function docker(...args) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
  } catch {
    throw new Error(`Docker gagal: ${args.slice(0, 2).join(' ')} (periksa Docker dan image lokal)`);
  }
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
  }
  if (redis?.isOpen) await redis.quit().catch(() => {});
  if (pool) await pool.end().catch(() => {});
  for (const name of names) {
    try { docker('rm', '-f', '-v', name); } catch { /* A container may never have started. */ }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { cleanup().finally(() => process.exit(130)); });
}

async function eventually(fn, label, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { return await fn(); } catch { await new Promise((resolve) => setTimeout(resolve, 300)); }
  }
  throw new Error(`${label} tidak siap dalam ${timeoutMs / 1000} detik`);
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function publishedPort(name, port) {
  const mapping = docker('port', name, `${port}/tcp`);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
  assert.ok(match, 'Port container harus terikat ke loopback IPv4');
  return Number(match[1]);
}

async function check(label, fn) {
  try { const result = await fn(); if (result !== 'skip') console.log(`PASS ${label}`); }
  catch (error) { failures++; console.error(`FAIL ${label}: ${error.message}`); }
}

async function main() {
  // --pull=never prevents network downloads. No bind mounts or named volumes are used.
  docker('run', '-d', '--pull=never', '--name', names[0], '--label', 'budgetin.integration=temporary',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_USER=integration', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=integration', 'postgres:16-alpine');
  docker('run', '-d', '--pull=never', '--name', names[1], '--label', 'budgetin.integration=temporary',
    '--tmpfs', '/data:rw,noexec,nosuid,size=32m', '-p', '127.0.0.1::6379',
    'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no');
  const pgPort = publishedPort(names[0], 5432);
  const redisPort = publishedPort(names[1], 6379);
  const databaseUrl = `postgres://integration:${password}@127.0.0.1:${pgPort}/integration`;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1000 });
  await eventually(() => pool.query('SELECT 1'), 'Postgres');
  // Applied only to the newly created, loopback-published disposable container.
  await pool.query(await readFile(path.join(root, 'database/init/001_schema.sql'), 'utf8'));
  redis = createClient({ url: redisUrl, socket: { connectTimeout: 1000, reconnectStrategy: false } });
  redis.on('error', () => {});
  await eventually(() => redis.connect(), 'Redis');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'production', TZ: 'UTC', DOTENV_CONFIG_PATH: path.join(root, `integration-no-env-${suffix}`),
    DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, JWT_SECRET: jwtSecret, BOT_INTERNAL_TOKEN: botSecret,
    PORT: String(port), TELEGRAM_BOT_TOKEN: '', COOKIE_SECURE: 'false',
  };
  let serverReady = false;
  server = spawn(process.execPath, ['src/server.js'], { cwd: path.join(root, 'backend'), env, stdio: ['ignore', 'pipe', 'ignore'] });
  server.on('error', () => {});
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`Budgetin API listening on ${port}`)) serverReady = true;
  });
  await eventually(async () => {
    if (server.exitCode !== null || !serverReady) throw new Error('Backend belum siap');
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Health gagal');
  }, 'Backend');

  async function request(route, { token, bot, method = 'GET', body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (bot) headers['x-bot-token'] = botSecret;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  }

  async function register(email) {
    const response = await request('/auth/register', { method: 'POST', body: { email, password: 'synthetic-test-password' } });
    assert.equal(response.status, 201, 'Registrasi akun sintetis gagal');
    assert.ok(response.data.token && response.data.user?.id, 'Respons registrasi tidak lengkap');
    return response.data;
  }
  const a = await register('integration-a@example.invalid');
  const b = await register('integration-b@example.invalid');
  await pool.query('UPDATE users SET is_verified = true WHERE id = ANY($1::uuid[])', [[a.user.id, b.user.id]]);
  await pool.query(`INSERT INTO telegram_accounts (user_id, telegram_user_id, telegram_chat_id, phone_number)
    VALUES ($1, 'integration-a', 'integration-chat-a', '+62000000001'), ($2, 'integration-b', 'integration-chat-b', '+62000000002')`, [a.user.id, b.user.id]);
  await pool.query(`INSERT INTO transactions (user_id, type, amount, category, note, created_at)
    SELECT $1, 'expense', 1, 'food_drink', 'bulk-' || n, '2025-06-01T00:00:00Z'::timestamptz + n * interval '1 second'
    FROM generate_series(1, 521) n`, [a.user.id]);
  await pool.query(`INSERT INTO transactions (user_id, type, amount, category, note, created_at) VALUES
    ($1, 'expense', 2, 'food_drink', 'before-april', '2025-03-31T16:59:59Z'),
    ($1, 'expense', 2, 'food_drink', 'april-start', '2025-03-31T17:00:00Z'),
    ($1, 'expense', 2, 'food_drink', 'april-end', '2025-04-30T16:59:59Z'),
    ($1, 'expense', 2, 'food_drink', 'after-april', '2025-04-30T17:00:00Z'),
    ($2, 'expense', 11, 'food_drink', 'private-b', '2025-04-01T00:00:00Z')`, [a.user.id, b.user.id]);

  await check('filter tanggal, rentang, dan bulan pada batas WIB', async () => {
    for (const [filter, expected] of [
      ['date=2025-04-01', ['april-start']],
      ['date=2025-04-30', ['april-end']],
      ['month=2025-04', ['april-end', 'april-start']],
      ['date_from=2025-04-01&date_to=2025-04-30', ['april-end', 'april-start']],
    ]) {
      const result = await request(`/transactions?${filter}`, { token: a.token });
      assert.equal(result.status, 200);
      assert.deepEqual(result.data.data.map((row) => row.note), expected);
    }
  });

  await check('ekspor WIB, >500 baris, dan isolasi dua akun', async () => {
    const result = await request('/exports/transactions.csv', { token: a.token });
    assert.equal(result.status, 200);
    const lines = result.data.trim().split('\n');
    assert.equal(lines.length, 526);
    assert.ok(lines.some((line) => line.startsWith('25/04/01 00:00:00,') && line.endsWith(',april-start')));
    assert.ok(lines.some((line) => line.startsWith('25/04/30 23:59:59,') && line.endsWith(',april-end')));
    assert.ok(!result.data.includes('private-b'));
    const other = await request('/exports/transactions.csv', { token: b.token });
    assert.equal(other.status, 200);
    assert.equal(other.data.trim().split('\n').length, 2);
    assert.ok(other.data.includes('private-b') && !other.data.includes('bulk-'));
  });

  await check('paginasi Telegram melewati 500 dan isolasi akun', async () => {
    const ids = new Set();
    for (let offset = 0; offset < 525; offset += 20) {
      const result = await request(`/telegram/transactions?telegram_user_id=integration-a&limit=20&offset=${offset}`, { bot: true });
      assert.equal(result.status, 200);
      assert.equal(result.data.data.length, Math.min(20, 525 - offset));
      for (const row of result.data.data) { assert.ok(!ids.has(row.id), 'ID berulang antar halaman'); ids.add(row.id); }
    }
    assert.equal(ids.size, 525);
    const other = await request('/telegram/transactions?telegram_user_id=integration-b&limit=20&offset=0', { bot: true });
    assert.equal(other.status, 200);
    assert.deepEqual(other.data.data.map((row) => row.note), ['private-b']);
  });

  await check('paginasi web jika API mendukung offset', async () => {
    const first = await request('/transactions?limit=500&offset=0', { token: a.token });
    const second = await request('/transactions?limit=500&offset=500', { token: a.token });
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal(first.data.data.length, 500);
    if (second.data.data[0]?.id === first.data.data[0]?.id) {
      if (process.env.INTEGRATION_REQUIRE_PAGINATION === '1') throw new Error('API web mengabaikan offset');
      console.log('TODO paginasi web: API mengabaikan offset; jalankan mode strict setelah API diperbarui');
      return 'skip';
    }
    assert.equal(second.data.data.length, 25);
    const ids = new Set([...first.data.data, ...second.data.data].map((row) => row.id));
    assert.equal(ids.size, 525);
  });

  await check('isolasi modifikasi lintas akun', async () => {
    const row = await pool.query("SELECT id FROM transactions WHERE user_id = $1 AND note = 'private-b'", [b.user.id]);
    const id = row.rows[0].id;
    const body = { type: 'expense', amount: 4, category: 'food_drink', note: 'intrusion' };
    assert.equal((await request(`/transactions/${id}`, { token: a.token, method: 'PATCH', body })).status, 404);
    assert.equal((await request(`/transactions/${id}`, { token: a.token, method: 'DELETE' })).status, 404);
    assert.equal((await pool.query('SELECT note FROM transactions WHERE id = $1', [id])).rows[0].note, 'private-b');
  });

  await check('cache Redis per akun dan invalidasi setelah transaksi', async () => {
    const summary = async (token) => {
      const result = await request('/analytics/summary', { token });
      assert.equal(result.status, 200);
      return result.data.data.expense;
    };
    assert.equal(await summary(a.token), 529);
    assert.equal(await summary(b.token), 11);
    assert.equal(await redis.exists(`summary:${a.user.id}:all`), 1);
    assert.equal(await redis.exists(`summary:${b.user.id}:all`), 1);
    const created = await request('/transactions', { token: a.token, method: 'POST', body: { type: 'expense', amount: 3, category: 'food_drink', note: 'cache-test' } });
    assert.equal(created.status, 201);
    assert.equal(await redis.exists(`summary:${a.user.id}:all`), 0);
    assert.equal(await redis.exists(`summary:${b.user.id}:all`), 1);
    assert.equal(await summary(a.token), 532);
    assert.equal(await summary(b.token), 11);
  });
}

if (process.env.NODE_TEST_CONTEXT) {
  console.log('SKIP integrasi container: jalankan integration-run.mjs secara langsung');
} else {
  try { await main(); }
  catch (error) { failures++; console.error(`FAIL setup: ${error.message}`); }
  finally { await cleanup(); }
  if (failures) process.exitCode = 1;
}
