import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
process.env.BACKEND_URL = 'http://synthetic-backend.invalid';
process.env.BOT_INTERNAL_TOKEN = 'synthetic-internal-token';
const { handleUpdate } = await import('../src/bot.js');
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
});

const token = 'abcdefghijklmnopqrstuv';
const telegramUrl = 'https://api.telegram.org/botsynthetic-test-token/';
const backendUrl = 'http://synthetic-backend.invalid/telegram/inactivity/response';
const message = (text) => ({ chat: { id: 123, type: 'private' }, from: { id: 123 }, text });
const callback = (data = `inactive:keep:${token}`) => ({
  id: 'synthetic-callback', from: { id: 123 },
  message: { chat: { id: 123, type: 'private' } }, data,
});

function mockFetch({ account = { is_inactive: true }, response, failAck = false } = {}) {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ address, body, options });
    if (address === `${telegramUrl}answerCallbackQuery`) {
      if (failAck) throw new Error('synthetic acknowledgement failure');
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (address === `${telegramUrl}sendMessage`) return { ok: true, json: async () => ({ ok: true }) };
    if (address.startsWith('http://synthetic-backend.invalid/telegram/account?')) {
      return { ok: true, json: async () => ({ user: account }) };
    }
    if (address === backendUrl && response) return response(options);
    throw new Error(`Unexpected mocked request: ${address}`);
  };
  return requests;
}

for (const action of ['keep', 'delete']) {
  test(`private ${action} callback is acknowledged and sent directly to the backend`, async () => {
    const requests = mockFetch({ response: async () => ({
      ok: true, json: async () => ({ message: `Hasil ${action}: ${token}\u0000<script>literal</script>` }),
    }) });
    await handleUpdate({ callback_query: callback(`inactive:${action}:${token}`), message: message('/makan nasi 18000') });
    assert.deepEqual(requests.map((item) => item.address), [
      `${telegramUrl}answerCallbackQuery`, backendUrl, `${telegramUrl}sendMessage`,
    ]);
    assert.equal(requests[0].body.callback_query_id, 'synthetic-callback');
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(requests[1].options.headers['x-bot-token'], 'synthetic-internal-token');
    assert.deepEqual(requests[1].body, { telegram_user_id: '123', action, token });
    assert.ok(requests[1].options.signal instanceof AbortSignal);
    assert.equal(requests[2].body.chat_id, 123);
    assert.equal(requests[2].body.parse_mode, undefined);
    assert.equal(requests[2].body.text, `Hasil ${action}: [disembunyikan]<script>literal</script>`);
    assert.ok(!requests[2].body.text.includes(token));
  });
}

test('rejects malformed, group, mismatched, and missing sender callbacks without backend calls', async () => {
  const requests = mockFetch();
  const cases = [
    callback('inactive:keep:short'), callback(`inactive:keep:${token}extra`),
    callback(`inactive:KEEP:${token}`), callback(`inactive:delete:${token}!`),
    callback(`inactive:keep:${token}\n`), callback(`other:keep:${token}`),
    { ...callback(), data: null },
    { ...callback(), message: { chat: { id: -123, type: 'group' } } },
    { ...callback(), message: { chat: { id: 123, type: 'group' } } },
    { ...callback(), message: { chat: { id: 456, type: 'private' } } },
    { ...callback(), message: { chat: { id: 0, type: 'private' } } },
    { ...callback(), message: undefined }, { ...callback(), from: undefined },
  ];
  for (const query of cases) await handleUpdate({ callback_query: query });
  await handleUpdate({ callback_query: { ...callback(), id: undefined } });
  assert.equal(requests.length, cases.length);
  assert.ok(requests.every((item) => item.address === `${telegramUrl}answerCallbackQuery`));
  assert.ok(requests.every((item) => !item.body.text.includes(token)));
});

test('a failed acknowledgement does not prevent processing a valid callback', async () => {
  const requests = mockFetch({ failAck: true, response: async () => ({ ok: true, json: async () => ({ message: 'Diterima.' }) }) });
  await handleUpdate({ callback_query: callback() });
  assert.ok(requests.some((item) => item.address === backendUrl));
  assert.equal(requests.at(-1).body.text, 'Diterima.');
});

test('cleans control characters before redacting a token and bounds backend text', async () => {
  const requests = mockFetch({ response: async () => ({
    ok: true, json: async () => ({ message: `${token.slice(0, 10)}\u0000${token.slice(10)} ${'x'.repeat(1200)}` }),
  }) });
  await handleUpdate({ callback_query: callback() });
  const text = requests.at(-1).body.text;
  assert.ok(!text.includes(token));
  assert.match(text, /^\[disembunyikan\]/);
  assert.equal(text.length, 1000);
});

test('a repeated callback relies on the backend replay decision and reports no false success', async () => {
  let count = 0;
  const requests = mockFetch({ response: async () => {
    count += 1;
    return count === 1
      ? { ok: true, json: async () => ({ message: 'Respons dicatat.' }) }
      : { ok: false, status: 409 };
  } });
  await handleUpdate({ callback_query: callback() });
  await handleUpdate({ callback_query: callback() });
  assert.equal(count, 2);
  const messages = requests.filter((item) => item.address === `${telegramUrl}sendMessage`);
  assert.equal(messages[0].body.text, 'Respons dicatat.');
  assert.match(messages[1].body.text, /belum dapat dipastikan/);
});

for (const failure of ['replay', 'server', 'network', 'invalid-json', 'explicit-failure']) {
  test(`${failure} does not claim an account state or display backend error/token`, async () => {
    const requests = mockFetch({ response: async () => {
      if (failure === 'network') throw new Error(`network ${token}`);
      if (failure === 'invalid-json') return { ok: true, json: async () => { throw new Error('invalid'); } };
      if (failure === 'explicit-failure') return { ok: true, json: async () => ({ ok: false, message: `deleted ${token}` }) };
      return { ok: false, status: failure === 'replay' ? 409 : 500, json: async () => ({ error: `deleted ${token}` }) };
    } });
    await handleUpdate({ callback_query: callback(`inactive:delete:${token}`) });
    const text = requests.at(-1).body.text;
    assert.match(text, /belum dapat dipastikan/);
    assert.doesNotMatch(text, /deleted|berhasil|dihapus/);
    assert.ok(!text.includes(token));
  });
}

test('backend timeout is bounded and reported as an uncertain outcome', async () => {
  let timeoutMs;
  AbortSignal.timeout = (ms) => {
    if (ms === 15_000 && timeoutMs === undefined) {
      // The first timeout belongs to callback acknowledgement; keep it immediate and inert.
      timeoutMs = 0;
      return new AbortController().signal;
    }
    timeoutMs = ms;
    return AbortSignal.abort();
  };
  const requests = mockFetch({ response: async ({ signal }) => {
    assert.equal(signal.aborted, true);
    throw new Error('synthetic timeout');
  } });
  await handleUpdate({ callback_query: callback() });
  assert.equal(timeoutMs, 15_000);
  assert.match(requests.at(-1).body.text, /belum dapat dipastikan/);
});

test('inactive account cannot perform ordinary actions, but can use the inactivity callback', async () => {
  const requests = mockFetch({ response: async () => ({ ok: true, json: async () => ({ message: 'Respons dicatat.' }) }) });
  await handleUpdate({ message: message('/makan nasi 18000') });
  assert.match(requests.at(-1).body.text, /peringatan pribadi Telegram/);
  assert.match(requests.at(-1).body.text, /\/tentang/);
  assert.ok(!requests.some((item) => item.address.endsWith('/telegram/transactions')));
  requests.length = 0;
  await handleUpdate({ callback_query: callback() });
  assert.ok(requests.some((item) => item.address === backendUrl));
  assert.ok(!requests.some((item) => item.address.includes('/telegram/account?')));
});

test('deleted and blocked statuses keep precedence over inactive status', async () => {
  for (const [account, expected] of [
    [{ is_deleted: true, is_inactive: true }, /dinonaktifkan/],
    [{ is_blocked: true, is_inactive: true }, /diblokir/],
  ]) {
    const requests = mockFetch({ account });
    await handleUpdate({ message: message('/ringkasan') });
    assert.match(requests.at(-1).body.text, expected);
    assert.doesNotMatch(requests.at(-1).body.text, /peringatan pribadi Telegram/);
  }
});
