import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Opt-in runner: only newly created loopback containers are used; no environment URLs are read.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suffix = randomBytes(12).toString('hex');
const names = [`budgetin-idem-pg-${suffix}`, `budgetin-idem-redis-${suffix}`];
const created = [];
const password = randomBytes(24).toString('hex');
const botSecret = randomBytes(32).toString('hex');
let pool;
let server;
let cleaning;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
    }
    if (pool) await pool.end();
    for (const name of created) {
      try { docker('rm', '-f', '-v', name); } catch (error) { console.error(`Cleanup failed for ${name}: ${error.message}`); process.exitCode = 1; }
    }
  })();
  return cleaning;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cleanup().finally(() => process.exit(130)));
async function eventually(fn, label) {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    try { return await fn(); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error(`${label} was not ready`);
}
function containerPort(name, port) {
  const match = /^127\.0\.0\.1:(\d+)$/.exec(docker('port', name, `${port}/tcp`));
  assert.ok(match, 'container must be bound to loopback');
  return Number(match[1]);
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function main() {
  docker('run', '-d', '--pull=never', '--name', names[0], '--label', 'budgetin.idempotency=temporary',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m', '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_USER=test', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=test', 'postgres:16-alpine');
  created.push(names[0]);
  docker('run', '-d', '--pull=never', '--name', names[1], '--label', 'budgetin.idempotency=temporary',
    '--tmpfs', '/data:rw,noexec,nosuid,size=32m', '-p', '127.0.0.1::6379',
    'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no');
  created.push(names[1]);
  const databaseUrl = `postgres://test:${password}@127.0.0.1:${containerPort(names[0], 5432)}/test`;
  const redisUrl = `redis://127.0.0.1:${containerPort(names[1], 6379)}`;
  pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1000 });
  await eventually(() => pool.query('SELECT 1'), 'Postgres');
  const schema = await readFile(path.join(root, 'database/init/001_schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  const users = await pool.query("INSERT INTO users (is_verified) VALUES (true), (true) RETURNING id");
  await pool.query(`INSERT INTO telegram_accounts (user_id, telegram_user_id, telegram_chat_id, phone_number)
    VALUES ($1, 'synthetic-a', 'chat-a', 'phone-a'), ($2, 'synthetic-b', 'chat-b', 'phone-b')`,
  [users.rows[0].id, users.rows[1].id]);
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    NODE_ENV: 'production', DOTENV_CONFIG_PATH: path.join(root, `nonexistent-idem-${suffix}`),
    DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, JWT_SECRET: randomBytes(32).toString('hex'),
    BOT_INTERNAL_TOKEN: botSecret, TELEGRAM_BOT_TOKEN: '', PORT: String(port),
  };
  let ready = false;
  let log = '';
  server = spawn(process.execPath, ['src/server.js'], { cwd: path.join(root, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', (error) => { log += error.message; });
  server.stdout.on('data', (chunk) => { if (String(chunk).includes(`Budgetin API listening on ${port}`)) ready = true; });
  server.stderr.on('data', (chunk) => { log += chunk; });
  await eventually(async () => { if (!ready) throw new Error(log); }, 'Backend');
  const base = `http://127.0.0.1:${port}`;
  async function request(body, method = 'POST', route = '/telegram/transactions') {
    const response = await fetch(base + route, {
      method, headers: { 'x-bot-token': botSecret, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() };
  }
  const input = { telegram_user_id: 'synthetic-a', type: 'expense', amount: 125, category: 'food_drink', note: 'synthetic' };
  const post = (extra) => request({ ...input, ...extra });
  const first = await post({ telegram_update_id: 0 });
  assert.equal(first.status, 201);
  const retry = await post({ telegram_update_id: 0 });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.data, first.body.data);
  assert.ok(retry.body.data.id && retry.body.data.category_label);
  assert.equal((await post({ telegram_update_id: 0, note: 'different' })).status, 409);
  assert.equal((await post({ telegram_update_id: 0, telegram_user_id: 'synthetic-b' })).status, 409);
  console.log('PASS retry, response shape, owner and payload mismatch');

  const simultaneous = await Promise.all(Array.from({ length: 24 }, () => post({ telegram_update_id: 1 })));
  assert.equal(simultaneous.filter((r) => r.status === 201).length, 1);
  assert.equal(simultaneous.filter((r) => r.status === 200).length, 23);
  assert.equal(new Set(simultaneous.map((r) => r.body.data.id)).size, 1);
  const race = await Promise.all([post({ telegram_update_id: 2 }), post({ telegram_update_id: 2, amount: 126 })]);
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  console.log('PASS concurrent identical and conflicting requests');

  await pool.query(`CREATE FUNCTION fail_synthetic_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.note = 'force rollback' THEN PERFORM pg_sleep(2); RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER fail_synthetic BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION fail_synthetic_transaction()');
  const failing = post({ telegram_update_id: 3, note: 'force rollback' });
  await eventually(async () => {
    const sleeping = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep' AND query LIKE '%INSERT INTO transactions%'");
    if (!sleeping.rowCount) throw new Error('insert has not reached trigger');
  }, 'rollback trigger');
  const waiting = post({ telegram_update_id: 3 });
  assert.equal((await failing).status, 500);
  assert.equal((await waiting).status, 201);
  assert.equal((await post({ telegram_update_id: 3 })).status, 200);
  assert.equal((await post({ telegram_update_id: 5, note: 'force rollback' })).status, 500);
  assert.equal((await pool.query('SELECT 1 FROM telegram_transaction_updates WHERE telegram_update_id = 5')).rowCount, 0);
  await pool.query('DROP TRIGGER fail_synthetic ON transactions');
  assert.equal((await post({ telegram_update_id: 5, note: 'force rollback' })).status, 201);
  assert.equal((await post({ telegram_update_id: 4, subcategory: 'missing' })).status, 400);
  assert.equal((await pool.query('SELECT 1 FROM telegram_transaction_updates WHERE telegram_update_id = 4')).rowCount, 0);
  assert.equal((await post({ telegram_update_id: 4 })).status, 201);
  console.log('PASS rollback after database failure and validation');

  await pool.query('UPDATE transactions SET note = $1 WHERE id = $2', ['edited', first.body.data.id]);
  assert.equal((await post({ telegram_update_id: 0 })).body.data.note, 'edited');
  assert.equal((await request({ telegram_user_id: 'synthetic-a' }, 'DELETE', `/telegram/transactions/${first.body.data.id}`)).status, 200);
  const deleted = await post({ telegram_update_id: 0 });
  assert.equal(deleted.status, 410);
  assert.match(deleted.body.error, /sudah dihapus/);
  assert.equal((await post({ telegram_update_id: 0, note: 'different' })).status, 409);
  assert.equal((await pool.query('SELECT 1 FROM transactions WHERE id = $1', [first.body.data.id])).rowCount, 0);
  console.log('PASS edited transaction and deletion tombstone');

  for (const invalid of [-1, 1.5, '10', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await post({ telegram_update_id: invalid })).status, 400);
  }
  assert.equal((await post({ telegram_update_id: Number.MAX_SAFE_INTEGER })).status, 201);
  const legacyA = await post({});
  const legacyB = await post({});
  assert.equal(legacyA.status, 201);
  assert.equal(legacyB.status, 201);
  assert.notEqual(legacyA.body.data.id, legacyB.body.data.id);
  console.log('PASS update ID validation and legacy behavior');
}

if (process.env.NODE_TEST_CONTEXT) {
  console.log('SKIP idempotency integration: run telegram-idempotency-integration.mjs directly');
} else {
  try { await main(); } catch (error) { console.error(error); process.exitCode = 1; } finally { await cleanup(); }
}
