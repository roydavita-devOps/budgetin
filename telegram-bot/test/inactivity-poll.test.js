import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterEach, test } from 'node:test';

process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
process.env.BACKEND_URL = 'http://synthetic-backend.invalid';
process.env.BOT_INTERNAL_TOKEN = 'synthetic-internal-token';
const { createPoller } = await import('../src/bot.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const telegram = 'https://api.telegram.org/botsynthetic-test-token/';
const backend = 'http://synthetic-backend.invalid/telegram/inactivity/';
const pollToken = 'ABCDEFGHIJKLMNOPQRSTUV';
const actionToken = 'abcdefghijklmnopqrstuv';
const about = (id) => ({ update_id: id, message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text: '/tentang' } });
const callback = (id, action = 'keep') => ({
  update_id: id,
  callback_query: { id: `callback-${id}`, from: { id: 123 }, message: { chat: { id: 123, type: 'private' } }, data: `inactive:${action}:${actionToken}` },
});
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function setup({ begins = [], updates = [], responses = [], confirms = [], completes = [], unsafes = [], send = () => ok({ ok: true }), answer = () => ok({ ok: true }) } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ address, body, options });
    const take = async (queue, fallback) => {
      const value = queue.length ? queue.shift() : fallback;
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value(options, body) : value;
    };
    if (address === `${backend}poll-begin`) return take(begins, ok({ enabled: true, token: pollToken }));
    if (address === `${telegram}getUpdates`) return take(updates, ok({ ok: true, result: [] }));
    if (address === `${backend}response`) return take(responses, ok({ message: 'Respons dicatat.' }));
    if (address === `${backend}poll-drained`) return take(confirms, ok({ success: true }));
    if (address === `${backend}poll-complete`) return take(completes, ok({ success: true }));
    if (address === `${backend}poll-unsafe`) return take(unsafes, ok({ success: true }));
    if (address === `${telegram}sendMessage`) return send(options, body);
    if (address === `${telegram}answerCallbackQuery`) return answer(options, body);
    throw new Error(`Unexpected mocked request: ${address}`);
  };
  return { calls, poller: createPoller(), of: (address) => calls.filter((call) => call.address === address) };
}

test('enabled empty poll begins first and confirms using exactly its token', async () => {
  const t = setup();
  assert.equal(await t.poller.pollOnce(), 'drained');
  assert.deepEqual(t.calls.map((x) => x.address), [`${backend}poll-begin`, `${telegram}getUpdates`, `${backend}poll-drained`]);
  assert.deepEqual(t.calls[1].body.allowed_updates, ['message', 'callback_query']);
  for (const call of [t.calls[0], t.calls[2]]) {
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['x-bot-token'], 'synthetic-internal-token');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.match(t.calls[0].body.ownerId, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(t.calls[2].body, { token: pollToken, ownerId: t.calls[0].body.ownerId });
});

for (const begin of [
  new Error('synthetic network failure'), { ok: false, status: 500 }, { ok: false, status: 409 }, { ok: false, status: 404 }, ok({}),
  ok({ enabled: true }), ok({ enabled: true, token: 'invalid' }), ok({ enabled: 'false' }),
  { ok: true, json: async () => { throw new Error('invalid json'); } },
]) {
  test('failed or ambiguous begin stops polling and never confirms drain', async () => {
    const t = setup({ begins: [begin] });
    assert.equal(await t.poller.pollOnce(), 'heartbeat_failed');
    assert.deepEqual(t.calls.map((x) => x.address), [`${backend}poll-begin`]);
  });
}

test('explicitly disabled mode polls without confirming drain', async () => {
  const t = setup({ begins: [ok({ enabled: false })] });
  assert.equal(await t.poller.pollOnce(), 'disabled');
  assert.deepEqual(t.calls.map((x) => x.address), [`${backend}poll-begin`, `${telegram}getUpdates`]);
});

test('poll begin reuses its request id after an uncertain response', async () => {
  const t = setup({ begins: [new Error('response lost'), ok({ enabled: true, token: pollToken })] });
  assert.equal(await t.poller.pollOnce(), 'heartbeat_failed');
  assert.equal(await t.poller.pollOnce(), 'drained');
  const attempts = t.of(`${backend}poll-begin`);
  assert.match(attempts[0].body.requestId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(attempts[0].body.requestId, attempts[1].body.requestId);
});

test('disabled deletion response is terminal and tells the user their account was not deleted', async () => {
  const t = setup({
    begins: [ok({ enabled: false }), ok({ enabled: false })],
    updates: [ok({ ok: true, result: [callback(7, 'delete')] }), ok({ ok: true, result: [] })],
    responses: [{ ok: false, status: 409, json: async () => ({ code: 'INACTIVITY_DISABLED', error: `synthetic ${actionToken}` }) }],
  });
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(await t.poller.pollOnce(), 'disabled');
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 8]);
  assert.equal(t.of(`${backend}response`).length, 1);
  assert.equal(t.of(`${backend}poll-drained`).length, 0);
  const text = t.of(`${telegram}sendMessage`)[0].body.text;
  assert.match(text, /Akun tidak dihapus/);
  assert.ok(!text.includes(actionToken));
});

test('disabled deletion after an uncertain attempt does not claim the earlier attempt failed', async () => {
  const t = setup({
    begins: [ok({ enabled: false })],
    updates: [ok({ ok: true, result: [callback(7, 'delete')] })],
    responses: [new Error('network'), { ok: false, status: 409, json: async () => ({ code: 'INACTIVITY_DISABLED' }) }],
  });
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(await t.poller.pollOnce(), 'processed');
  const text = t.of(`${telegram}sendMessage`).at(-1).body.text;
  assert.match(text, /Permintaan ini tidak menghapus akun/);
  assert.match(text, /percobaan sebelumnya belum pasti/);
  assert.equal(t.of(`${backend}response`).length, 2);
  assert.equal(t.of(`${telegram}getUpdates`).length, 1);
});

for (const response of [
  { ok: false, status: 409, json: async () => ({ error: 'Penghapusan sementara tidak tersedia. Akun tidak dihapus.' }) },
  { ok: false, status: 409, json: async () => ({ code: 'inactivity_disabled' }) },
  { ok: false, status: 409, json: async () => ({ code: 'INACTIVITY_DISABLED_EXTRA' }) },
  { ok: false, status: 503, json: async () => ({ code: 'INACTIVITY_DISABLED' }) },
]) {
  test('ambiguous or wrong-status disabled response does not release the callback', async () => {
    const t = setup({ updates: [ok({ ok: true, result: [callback(7, 'delete')] })], responses: [response] });
    assert.equal(await t.poller.pollOnce(), 'retry');
    assert.equal(t.of(`${backend}poll-complete`).length, 0);
    assert.equal(t.of(`${backend}poll-drained`).length, 0);
    assert.match(t.of(`${telegram}sendMessage`)[0].body.text, /belum dapat dipastikan/);
  });
}

test('retry holds callback offset, does not repeat ordinary updates, warns once, then confirms only an empty poll', async () => {
  const t = setup({
    updates: [
      ok({ ok: true, result: [about(100), callback(101), about(102)] }),
      ok({ ok: true, result: [] }),
    ],
    responses: [new Error('network'), { ok: false, status: 503 }, ok({ message: 'Respons dicatat.' })],
  });
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(t.of(`${backend}poll-drained`).length, 0);
  assert.equal(await t.poller.pollOnce(), 'drained');
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 103]);
  assert.equal(t.of(`${backend}poll-begin`).length, 2);
  assert.equal(t.of(`${backend}poll-complete`).length, 1);
  assert.equal(t.of(`${backend}response`).length, 3);
  assert.equal(t.of(`${telegram}answerCallbackQuery`).length, 1);
  const messages = t.of(`${telegram}sendMessage`).map((x) => x.body.text);
  assert.equal(messages.filter((text) => /belum dapat dipastikan/.test(text)).length, 1);
  assert.equal(messages.filter((text) => /Respons dicatat/.test(text)).length, 1);
  assert.equal(messages.length, 4);
});

test('failed getUpdates is retried using the same poll token and cannot confirm drain', async () => {
  const t = setup({
    updates: [new Error('poll failure'), ok({ ok: true, result: [callback(51)] }), ok({ ok: true, result: [] })],
    responses: [new Error('network'), ok({ message: 'Respons dicatat.' })],
  });
  await assert.rejects(t.poller.pollOnce());
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(t.of(`${backend}poll-drained`).length, 0);
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(await t.poller.pollOnce(), 'drained');
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 0, 52]);
  assert.equal(t.of(`${backend}poll-begin`).length, 2);
});

test('failed message after successful delete never retries the backend operation', async () => {
  const t = setup({
    updates: [ok({ ok: true, result: [callback(2, 'delete')] }), ok({ ok: true, result: [] })],
    send: () => { throw new Error('synthetic send failure'); },
  });
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(await t.poller.pollOnce(), 'drained');
  assert.equal(t.of(`${backend}response`).length, 1);
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 3]);
});

test('uncertain batch completion retries its token without polling or replaying updates', async () => {
  const t = setup({
    updates: [ok({ ok: true, result: [callback(2, 'delete'), about(3)] }), ok({ ok: true, result: [] })],
    completes: [new Error('completion response lost'), { ok: false, status: 409 }, ok({ success: true })],
  });
  assert.equal(await t.poller.pollOnce(), 'heartbeat_failed');
  assert.equal(await t.poller.pollOnce(), 'heartbeat_failed');
  assert.equal(t.of(`${backend}poll-begin`).length, 1);
  assert.equal(t.of(`${telegram}getUpdates`).length, 1);
  assert.equal(t.of(`${backend}response`).length, 1);
  assert.equal(t.of(`${telegram}sendMessage`).length, 2);
  assert.equal(t.of(`${backend}poll-drained`).length, 0);
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(await t.poller.pollOnce(), 'drained');
  const ownerId = t.of(`${backend}poll-begin`)[0].body.ownerId;
  assert.deepEqual(t.of(`${backend}poll-complete`).map((x) => x.body), Array(3).fill({ token: pollToken, ownerId }));
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 4]);
});

test('warning send and callback acknowledgement failures do not block retry or cause repeated warnings', async () => {
  const t = setup({
    updates: [ok({ ok: true, result: [callback(5)] }), ok({ ok: true, result: [callback(5)] }), ok({ ok: true, result: [callback(5)] })],
    responses: [new Error('offline'), new Error('offline'), ok({ message: 'Selesai.' })],
    answer: () => { throw new Error('ack failure'); },
    send: () => { throw new Error('message failure'); },
  });
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(t.of(`${telegram}answerCallbackQuery`).length, 1);
  assert.equal(t.of(`${telegram}sendMessage`).length, 2);
  assert.equal(t.of(`${backend}response`).length, 3);
});

test('only the known terminal conflict releases a failed callback', async () => {
  const t = setup({
    updates: [ok({ ok: true, result: [callback(8)] }), ok({ ok: true, result: [callback(8)] }), ok({ ok: true, result: [callback(8)] })],
    responses: [
      { ok: false, status: 401 },
      { ok: false, status: 409, json: async () => ({ error: 'ambiguous' }) },
      { ok: false, status: 409, json: async () => ({ error: 'Peringatan tidak berlaku lagi atau sudah diproses.' }) },
    ],
  });
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0]);
});

test('malformed success responses retain the callback until a valid terminal replay result', async () => {
  const bad = [
    { ok: true, json: async () => { throw new Error('invalid json'); } },
    ok(null), ok([]), ok({}), ok({ message: '  ' }), ok({ message: '\u0000\u202e' }),
    ok({ success: false, message: 'not applied' }),
  ];
  const t = setup({
    updates: [ok({ ok: true, result: [callback(9)] }), ok({ ok: true, result: [] })],
    responses: [...bad, { ok: false, status: 409, json: async () => ({ error: 'Peringatan tidak berlaku lagi atau sudah diproses.' }) }],
  });
  for (const _ of bad) assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(t.of(`${backend}poll-drained`).length, 0);
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(await t.poller.pollOnce(), 'drained');
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 10]);
  assert.equal(t.of(`${telegram}sendMessage`).filter((x) => /belum dapat dipastikan/.test(x.body.text)).length, 1);
  assert.match(t.of(`${telegram}sendMessage`).at(-1).body.text, /sudah diproses/);
});

test('explicit success true can finish a callback without a message', async () => {
  const t = setup({ updates: [ok({ ok: true, result: [callback(12)] })], responses: [ok({ success: true })] });
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(t.of(`${telegram}sendMessage`).at(-1).body.text, 'Respons diterima.');
});

test('failed drain confirmation retries the same token without starting another poll', async () => {
  const t = setup({ confirms: [new Error('offline'), ok({ success: true })] });
  assert.equal(await t.poller.pollOnce(), 'heartbeat_failed');
  assert.equal(await t.poller.pollOnce(), 'drained');
  assert.deepEqual(t.of(`${backend}poll-drained`).map((x) => x.body.token), [pollToken, pollToken]);
  const owners = t.of(`${backend}poll-begin`).map((x) => x.body.ownerId);
  assert.equal(new Set(owners).size, 1);
  assert.ok(t.of(`${backend}poll-drained`).every((x) => x.body.ownerId === owners[0]));
});

test('malformed or unsuccessful drain confirmations are not treated as confirmed', async () => {
  for (const result of [ok(null), ok({}), ok({ success: false }), { ok: true, json: async () => { throw new Error('invalid json'); } }]) {
    const t = setup({ confirms: [result] });
    assert.equal(await t.poller.pollOnce(), 'heartbeat_failed');
  }
});

test('poller instances in the same process use one owner identity', async () => {
  const t = setup();
  const another = createPoller();
  await t.poller.pollOnce();
  await another.pollOnce();
  const owners = t.of(`${backend}poll-begin`).map((x) => x.body.ownerId);
  assert.equal(owners.length, 2);
  assert.equal(owners[0], owners[1]);
});

test('separate bot processes generate distinct owner identities', () => {
  const botUrl = new URL('../src/bot.js', import.meta.url).href;
  const script = `
    let owner;
    globalThis.fetch = async (url, options) => {
      const address = String(url);
      if (address === 'http://synthetic-backend.invalid/telegram/inactivity/poll-begin') {
        owner = JSON.parse(options.body).ownerId;
        return { ok: true, json: async () => ({ enabled: false }) };
      }
      if (address === 'https://api.telegram.org/botsynthetic-test-token/getUpdates') {
        return { ok: true, json: async () => ({ ok: true, result: [] }) };
      }
      throw new Error('Unexpected mocked request');
    };
    const { createPoller } = await import(${JSON.stringify(botUrl)});
    await createPoller().pollOnce();
    process.stdout.write(owner);
  `;
  const owner = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, DOTENV_CONFIG_PATH: 'NUL' },
  });
  const first = owner();
  const second = owner();
  assert.match(first, /^[A-Za-z0-9_-]{22}$/);
  assert.match(second, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(first, second);
});

test('disabled mode resumes normal polling without replaying a failed ordinary update', async () => {
  const t = setup({ begins: [ok({ enabled: false }), ok({ enabled: false })], updates: [ok({ ok: true, result: [about(10)] }), ok({ ok: true, result: [] })], send: () => { throw new Error('message failure'); } });
  await assert.rejects(t.poller.pollOnce());
  assert.equal(await t.poller.pollOnce(), 'disabled');
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 11]);
  assert.equal(t.of(`${backend}poll-drained`).length, 0);
  assert.equal(t.of(`${backend}poll-unsafe`).length, 0);
});

test('enabled mode persists unsafe before resuming normal polling and empty confirmations', async () => {
  let sends = 0;
  let recoveryRequired = false;
  let purges = 0;
  const t = setup({
    updates: [ok({ ok: true, result: [about(10)] }), ok({ ok: true, result: [about(11)] }), ok({ ok: true, result: [] })],
    send: () => { if (++sends === 1) throw new Error('message failure'); return ok({ ok: true }); },
    unsafes: [() => { recoveryRequired = true; return ok({ success: true }); }],
    confirms: [() => { if (!recoveryRequired) purges += 1; return ok({ success: true }); }],
  });
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(await t.poller.pollOnce(), 'drained');
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 11, 12]);
  const unsafe = t.of(`${backend}poll-unsafe`);
  assert.equal(unsafe.length, 1);
  assert.deepEqual(unsafe[0].body, { token: pollToken, ownerId: t.of(`${backend}poll-begin`)[0].body.ownerId });
  assert.equal(t.of(`${backend}poll-drained`).length, 1);
  assert.equal(t.of(`${backend}poll-complete`).length, 1);
  assert.equal(recoveryRequired, true);
  assert.equal(purges, 0);
});

test('unsafe transition retries with the same token without polling when backend is unavailable', async () => {
  const t = setup({
    updates: [ok({ ok: true, result: [about(10)] }), ok({ ok: true, result: [] })],
    unsafes: [new Error('offline'), ok({ success: false }), ok({ success: true })],
    send: () => { throw new Error('message failure'); },
  });
  assert.equal(await t.poller.pollOnce(), 'heartbeat_failed');
  assert.equal(await t.poller.pollOnce(), 'heartbeat_failed');
  assert.equal(t.of(`${telegram}getUpdates`).length, 1);
  assert.equal(t.of(`${backend}poll-begin`).length, 1);
  assert.equal(t.of(`${backend}poll-drained`).length, 0);
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(await t.poller.pollOnce(), 'drained');
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 11]);
  assert.equal(new Set(t.of(`${backend}poll-unsafe`).map((x) => x.body.token)).size, 1);
});

test('callback after a failed ordinary update is processed after unsafe is persisted', async () => {
  let sends = 0;
  const t = setup({
    updates: [ok({ ok: true, result: [about(10), callback(11)] }), ok({ ok: true, result: [callback(11)] }), ok({ ok: true, result: [] })],
    send: () => { if (++sends === 1) throw new Error('ordinary send failure'); return ok({ ok: true }); },
  });
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(t.of(`${backend}response`).length, 0);
  assert.equal(await t.poller.pollOnce(), 'processed');
  assert.equal(t.of(`${backend}response`).length, 1);
  assert.equal(await t.poller.pollOnce(), 'drained');
  assert.equal(t.of(`${backend}poll-drained`).length, 1);
  assert.deepEqual(t.of(`${telegram}getUpdates`).map((x) => x.body.offset), [0, 11, 12]);
});

test('invalid update ID persists unsafe before stopping without advancing or polling again', async () => {
  const t = setup({
    updates: [ok({ ok: true, result: [{ message: { text: '/tentang' } }] })],
    unsafes: [new Error('offline'), ok({ success: true })],
  });
  assert.equal(await t.poller.pollOnce(), 'heartbeat_failed');
  assert.equal(t.of(`${telegram}getUpdates`).length, 1);
  assert.equal(await t.poller.pollOnce(), 'processed');
  const count = t.calls.length;
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(t.calls.length, count);
  assert.equal(t.of(`${backend}poll-unsafe`).length, 2);
  assert.equal(t.of(`${backend}poll-drained`).length, 0);
  assert.equal(t.of(`${backend}poll-complete`).length, 0);
});

test('disabled mode stops on invalid update ID without calling poll-unsafe', async () => {
  const t = setup({ begins: [ok({ enabled: false })], updates: [ok({ ok: true, result: [{ update_id: -1 }] })] });
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(await t.poller.pollOnce(), 'retry');
  assert.equal(t.of(`${telegram}getUpdates`).length, 1);
  assert.equal(t.of(`${backend}poll-unsafe`).length, 0);
});
