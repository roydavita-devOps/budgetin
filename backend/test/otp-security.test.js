import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { createClient } from 'redis';

// Do not load a developer's local environment while importing the server.
process.env.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), `budgetin-test-no-env-${process.pid}`);
const { createOtpRateLimit, validateRuntimeConfig } = await import('../src/server.js');

function fakeRedis() {
  const counters = new Map();
  return {
    isReady: true,
    counters,
    async eval(_script, { keys, arguments: args }) {
      return keys.flatMap((key) => {
        const count = (counters.get(key) || 0) + 1;
        counters.set(key, count);
        return [count, Number(args[0])];
      });
    },
  };
}

async function withServer(client, { sourceEnabled = false, trustProxy = false } = {}, run) {
  const app = express();
  if (trustProxy) app.set('trust proxy', 1);
  app.use(express.json());
  const limit = createOtpRateLimit({ client, secret: 'test-secret', sourceEnabled });
  app.post('/:action', (req, res, next) => limit(req.params.action)(req, res, next), (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const send = (action, phone, forwardedFor, code = '123456') => fetch(`http://127.0.0.1:${server.address().port}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
      body: JSON.stringify({ phone_number: phone, code }),
    });
    await run(send);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('production validation accepts either production signal and rejects missing, default, or short secrets', () => {
  const valid = { JWT_SECRET: 'random-example-jwt-value-over-32-bytes', BOT_INTERNAL_TOKEN: 'random-example-bot-value-over-32-bytes', DATABASE_URL: 'postgres://example:example-long-password-for-test@localhost/example' };
  for (const flag of [{ NODE_ENV: 'production' }, { COOKIE_SECURE: 'true' }, { COOKIE_SECURE: 'TRUE' }]) {
    assert.equal(validateRuntimeConfig({ ...valid, ...flag }).production, true);
    assert.throws(() => validateRuntimeConfig({ ...valid, ...flag, BOT_INTERNAL_TOKEN: valid.JWT_SECRET }), /different/);
    for (const url of ['', 'postgres://example:budgetin_password@localhost/example', 'postgres://example:short@localhost/example']) {
      assert.throws(() => validateRuntimeConfig({ ...valid, ...flag, DATABASE_URL: url }), /DATABASE_URL/);
    }
    for (const name of ['JWT_SECRET', 'BOT_INTERNAL_TOKEN']) {
      for (const value of ['', 'development_secret', 'change_me_in_production', 'short', ' '.repeat(40)]) {
        assert.throws(() => validateRuntimeConfig({ ...valid, ...flag, [name]: value }), new RegExp(name));
      }
    }
  }
  assert.equal(validateRuntimeConfig({}).production, false);
  assert.equal(validateRuntimeConfig({ OTP_TRUST_PROXY_HOPS: '' }).proxyHops, 0);
  assert.throws(() => validateRuntimeConfig({ OTP_TRUST_PROXY_HOPS: 'true' }), /OTP_TRUST_PROXY_HOPS/);
  assert.equal(validateRuntimeConfig({ OTP_TRUST_PROXY_HOPS: '2' }).proxyHops, 2);
});

test('limits each normalized account across instances and keeps request and verification counters separate', async () => {
  const client = fakeRedis();
  await withServer(client, {}, async (send) => {
    await withServer(client, {}, async (sendOtherInstance) => {
      for (let i = 0; i < 5; i++) assert.equal((await (i % 2 ? send : sendOtherInstance)('request', i % 2 ? '081234567890' : '+6281234567890')).status, 200);
      const blocked = await send('request', '+6281234567890', '198.51.100.1');
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get('retry-after'), '600');
      assert.equal((await send('request', '+6281234567891')).status, 200);
      for (let i = 0; i < 10; i++) assert.equal((await send('verify', '+6281234567890')).status, 200);
      assert.equal((await send('verify', '+6281234567890')).status, 429);
      assert.ok([...client.counters.keys()].every((key) => !key.includes('6281234567890')));
    });
  });
});

test('does not use forwarded headers or a shared source limit by default', async () => {
  const client = fakeRedis();
  await withServer(client, {}, async (send) => {
    for (let i = 0; i < 65; i++) {
      assert.equal((await send('request', `+62812345${String(i).padStart(5, '0')}`, '198.51.100.1')).status, 200);
    }
    assert.ok([...client.counters.keys()].every((key) => !key.includes(':source:')));
  });
});

test('applies a source limit only when trusted proxy source limiting is enabled', async () => {
  const client = fakeRedis();
  await withServer(client, { sourceEnabled: true, trustProxy: true }, async (send) => {
    for (let i = 0; i < 60; i++) {
      assert.equal((await send('request', `+62812345${String(i).padStart(5, '0')}`, '198.51.100.1')).status, 200);
    }
    assert.equal((await send('request', '+6281234500060', '198.51.100.1')).status, 429);
    assert.equal((await send('request', '+6281234500061', '198.51.100.2')).status, 200);
  });
});

test('fails closed on Redis errors and rejects invalid input before incrementing', async () => {
  const client = fakeRedis();
  await withServer(client, {}, async (send) => {
    assert.equal((await send('verify', '+6281234567890', null, 'bad')).status, 400);
    assert.equal(client.counters.size, 0);
    client.isReady = false;
    assert.equal((await send('request', '+6281234567890')).status, 503);
    client.isReady = true;
    client.eval = async () => { throw new Error('offline'); };
    assert.equal((await send('verify', '+6281234567890')).status, 503);
    client.eval = async () => [1];
    assert.equal((await send('request', '+6281234567890')).status, 503);
  });
});

test('real Redis atomically enforces a shared limit and expires keys', { skip: !process.env.BUDGETIN_TEST_REDIS_URL }, async () => {
  const first = createClient({ url: process.env.BUDGETIN_TEST_REDIS_URL, disableOfflineQueue: true });
  const second = first.duplicate();
  first.on('error', () => {});
  second.on('error', () => {});
  await Promise.all([first.connect(), second.connect()]);
  try {
    await withServer(first, {}, async (sendFirst) => {
      await withServer(second, {}, async (sendSecond) => {
        const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? sendFirst : sendSecond)('request', '+6281999999999')));
        assert.equal(responses.filter((response) => response.status === 200).length, 5);
        assert.equal(responses.filter((response) => response.status === 429).length, 15);
        const keys = await first.keys('otp-limit:request:account:*');
        assert.equal(keys.length, 1);
        const ttl = await first.ttl(keys[0]);
        assert.ok(ttl > 0 && ttl <= 600);
        await first.expire(keys[0], 1);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal((await sendSecond('request', '+6281999999999')).status, 200);
      });
    });
  } finally {
    await Promise.all([first.quit(), second.quit()]);
  }
});

test('OTP requests never create or send codes to old group or mismatched chat IDs', async () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
  let handler;
  let account;
  const calls = [];
  const context = vm.createContext({
    app: { post: (_path, ...handlers) => { handler = handlers.at(-1); } },
    otpRateLimit: () => () => {},
    findTelegramAccountByPhone: async () => account,
    createOtp: async () => { calls.push('create'); return '123456'; },
    sendTelegramOtp: async (chatId) => { calls.push(chatId); return true; },
  });
  vm.runInContext(section('function normalizePhone(', 'function generateOtp(') + section("app.post('/auth/request-otp'", "app.post('/auth/verify-otp'"), context);
  async function invoke() {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body: { phone_number: '081234567890' } }, res);
    return res;
  }
  let genericMessage;
  for (const value of [null, { telegram_user_id: '123', telegram_chat_id: '-123' }, { telegram_user_id: '123', telegram_chat_id: '456' }, { telegram_user_id: '0', telegram_chat_id: '0' }, { telegram_user_id: '', telegram_chat_id: '' }]) {
    account = value;
    const res = await invoke();
    assert.equal(res.statusCode, 200);
    genericMessage ||= res.body.message;
    assert.equal(res.body.message, genericMessage);
    assert.match(res.body.message, /\/mulai.*\/hubungkan_ulang/);
    assert.equal(calls.length, 0);
  }
  account = { telegram_user_id: '123', telegram_chat_id: '123' };
  const valid = await invoke();
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.body.message, genericMessage);
  assert.deepEqual(calls, ['create', '123']);
});

test('contact rejects non-private or invalid IDs before looking up or changing data', async () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
  let handler;
  let lookups = 0;
  const context = vm.createContext({
    app: { post: (_path, ...handlers) => { handler = handlers.at(-1); } },
    botInternalRequired: () => {},
    findTelegramAccountByTelegramUserId: async () => { lookups++; throw new Error('lookup reached'); },
  });
  vm.runInContext(section('function normalizePhone(', 'function generateOtp(') + section("app.post('/telegram/contact'", "app.patch('/telegram/profile'"), context);
  const invoke = async (user, chat) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body: { phone_number: '081234567890', telegram_user_id: user, telegram_chat_id: chat } }, res);
    return res;
  };
  for (const [user, chat] of [['123', '-123'], ['123', '456'], ['0', '0'], ['-1', '-1'], ['abc', 'abc'], ['', '123']]) {
    assert.equal((await invoke(user, chat)).statusCode, 400);
    assert.equal(lookups, 0);
  }
  await assert.rejects(invoke('123', '123'), /lookup reached/);
  assert.equal(lookups, 1);
});
