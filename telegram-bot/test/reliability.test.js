import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

process.env.DOTENV_CONFIG_PATH = 'synthetic-nonexistent-test.env';
process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
process.env.BACKEND_URL = 'http://synthetic-backend.invalid';
process.env.BOT_INTERNAL_TOKEN = 'synthetic-internal-token';

const bot = await import('../src/bot.js');
const { handleUpdate } = bot;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function transactionUpdate(updateId) {
  return {
    update_id: updateId,
    message: {
      message_id: 42,
      chat: { id: 123, type: 'private' },
      from: { id: 123, first_name: 'Test' },
      text: '/makan nasi 18000',
    },
  };
}

function syntheticBackend({ firstAccountFailure, firstTransactionFailure, firstMessageFailure = false } = {}) {
  const requests = [];
  const transactions = new Map();
  const messages = [];
  let transactionAttempts = 0;
  let messageAttempts = 0;
  let accountAttempts = 0;

  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ address, method: options.method || 'GET', body });

    if (address.startsWith('http://synthetic-backend.invalid/telegram/account?')) {
      accountAttempts += 1;
      if (accountAttempts === 1 && firstAccountFailure === 'network') throw new Error('synthetic account disconnect');
      if (accountAttempts === 1 && firstAccountFailure === 'server') {
        return { ok: false, status: 503, json: async () => ({ error: 'synthetic account unavailable' }) };
      }
      return { ok: true, status: 200, json: async () => ({ user: { is_verified: true } }) };
    }
    if (address === 'http://synthetic-backend.invalid/telegram/transactions' && options.method === 'POST') {
      transactionAttempts += 1;
      if (firstTransactionFailure === 'validation') {
        return { ok: false, status: 400, json: async () => ({ error: 'synthetic invalid transaction' }) };
      }
      // Missing keys cannot provide idempotency; never deduplicate them accidentally.
      const key = body.telegram_update_id == null ? Symbol('missing update ID') : String(body.telegram_update_id);
      if (!transactions.has(key)) {
        transactions.set(key, { type: body.type, amount: body.amount, category_label: 'Makan' });
      }
      if (transactionAttempts === 1 && firstTransactionFailure === 'network') {
        throw new Error('synthetic connection lost after commit');
      }
      if (transactionAttempts === 1 && firstTransactionFailure === 'body') {
        return { ok: true, status: 200, json: async () => { throw new Error('synthetic response truncated'); } };
      }
      if (transactionAttempts === 1 && firstTransactionFailure === 'server') {
        return { ok: false, status: 503, json: async () => ({ error: 'synthetic upstream unavailable' }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: transactions.get(key) }) };
    }
    if (address === 'https://api.telegram.org/botsynthetic-test-token/sendMessage') {
      messageAttempts += 1;
      messages.push(body.text);
      if (messageAttempts === 1 && firstMessageFailure) throw new Error('synthetic Telegram disconnect');
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`Unexpected synthetic request: ${address}`);
  };

  return { requests, transactions, messages };
}

async function observeUpdate(update) {
  try {
    await handleUpdate(update);
    return null;
  } catch (error) {
    return error;
  }
}

function assertUncertainOutcome(error, messages) {
  assert.ok(!messages.some((message) => /\b(?:gagal|failed|tidak tersimpan)\b/i.test(message)),
    'an ambiguous outcome must not be reported as a definite failure');
  assert.ok(!messages.some((message) => /\b(?:tersimpan|berhasil|saved|succeeded)\b/i.test(message)
    && !/\b(?:belum|tidak|mungkin|apakah|belum diketahui)\b/i.test(message)),
  'an ambiguous outcome must not be reported as a definite success');
  assert.ok(error instanceof Error, 'the handler must propagate a retryable failure');
}

test('passes the Telegram update number to the transaction API', async () => {
  const mock = syntheticBackend();
  await handleUpdate(transactionUpdate(987654321));
  const posts = mock.requests.filter((request) => request.address.endsWith('/telegram/transactions'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.telegram_update_id, 987654321);
  assert.equal(posts[0].body.telegram_user_id, '123');
  assert.equal(posts[0].body.amount, 18000);
  assert.match(mock.messages.join('\n'), /tersimpan/i);
});

for (const failure of ['network', 'body', 'server']) {
  test(`preserves uncertainty when backend ${failure} fails after a possible commit`, async () => {
    const mock = syntheticBackend({ firstTransactionFailure: failure });
    const error = await observeUpdate(transactionUpdate(1001));
    assert.equal(mock.transactions.size, 1, 'the backend mock committed before the response failed');
    assertUncertainOutcome(error, mock.messages);
  });
}

for (const failure of ['network', 'server']) {
  test(`account ${failure} failure propagates for retry without a transaction`, async () => {
    const mock = syntheticBackend({ firstAccountFailure: failure });
    const error = await observeUpdate(transactionUpdate(1002));
    assert.ok(error instanceof Error, 'account lookup failure must remain retryable');
    assert.equal(mock.transactions.size, 0);
    assert.ok(!mock.messages.some((message) => /\bgagal\b/i.test(message)));
  });
}

test('a Telegram send failure after commit propagates for retry', async () => {
  const mock = syntheticBackend({ firstMessageFailure: true });
  const error = await observeUpdate(transactionUpdate(1003));
  assert.equal(mock.transactions.size, 1);
  assert.ok(error instanceof Error, 'failed Telegram delivery must remain retryable');
});

test('transaction validation 4xx is terminal and reported to the user', async () => {
  const mock = syntheticBackend({ firstTransactionFailure: 'validation' });
  await handleUpdate(transactionUpdate(1004));
  assert.equal(mock.transactions.size, 0);
  assert.match(mock.messages.join('\n'), /synthetic invalid transaction/i);
});

test('legacy updates without an update ID still record a transaction', async () => {
  const mock = syntheticBackend();
  const { update_id, ...legacyUpdate } = transactionUpdate(1005);
  await handleUpdate(legacyUpdate);
  assert.equal(mock.transactions.size, 1);
  assert.match(mock.messages.join('\n'), /tersimpan/i);
});

for (const failure of ['network', 'body', 'server', 'telegram']) {
  test(`replaying the same update after ${failure} disconnect does not duplicate a mock transaction`, async () => {
    const mock = syntheticBackend(failure === 'telegram'
      ? { firstMessageFailure: true }
      : { firstTransactionFailure: failure });
    const update = transactionUpdate(2001);
    await observeUpdate(update);
    await observeUpdate(update);
    await observeUpdate(transactionUpdate(2002));

    const posts = mock.requests.filter((request) => request.address.endsWith('/telegram/transactions'));
    assert.ok(posts.length >= 2, 'the replay and distinct update must reach the mock backend');
    assert.ok(posts.every((request) => [2001, 2002].includes(request.body.telegram_update_id)),
      'all attempts must carry their original update ID');
    assert.ok(posts.some((request) => request.body.telegram_update_id === 2001));
    assert.ok(posts.some((request) => request.body.telegram_update_id === 2002));
    assert.equal(mock.transactions.size, 2, 'one transaction per distinct update, including the replay');
  });
}

for (const [failure, options] of [
  ['account network', { firstAccountFailure: 'network' }],
  ['account server', { firstAccountFailure: 'server' }],
  ['transaction network', { firstTransactionFailure: 'network' }],
  ['transaction server', { firstTransactionFailure: 'server' }],
  ['Telegram delivery', { firstMessageFailure: true }],
]) test(`polling retains offset after ${failure} and advances after replay`, async () => {
  assert.equal(typeof bot.createPoller, 'function', 'export createPoller() for offset testing');
  const poller = bot.createPoller();
  assert.equal(typeof poller.pollOnce, 'function');
  const mock = syntheticBackend(options);
  const backendFetch = globalThis.fetch;
  const offsets = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === 'https://api.telegram.org/botsynthetic-test-token/getUpdates') {
      offsets.push(JSON.parse(options.body).offset);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: offsets.length <= 2 ? [transactionUpdate(3001)] : [] }) };
    }
    return backendFetch(url, options);
  };
  await observePoll(poller);
  await observePoll(poller);
  await observePoll(poller);
  assert.equal(offsets.length, 3);
  assert.equal(offsets[1], offsets[0], 'failure must not acknowledge the update');
  assert.equal(offsets[2], 3002, 'successful replay must acknowledge the update');
  assert.equal(mock.transactions.size, 1);
});

test('polling acknowledges a terminal transaction validation error', async () => {
  const poller = bot.createPoller();
  const mock = syntheticBackend({ firstTransactionFailure: 'validation' });
  const backendFetch = globalThis.fetch;
  const offsets = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === 'https://api.telegram.org/botsynthetic-test-token/getUpdates') {
      offsets.push(JSON.parse(options.body).offset);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: offsets.length === 1 ? [transactionUpdate(4001)] : [] }) };
    }
    return backendFetch(url, options);
  };
  await poller.pollOnce();
  await poller.pollOnce();
  assert.equal(offsets[1], 4002);
  assert.match(mock.messages.join('\n'), /synthetic invalid transaction/i);
  assert.equal(mock.transactions.size, 0);
});

test('polling retains the failed update after acknowledging an earlier update', async () => {
  const poller = bot.createPoller();
  const mock = syntheticBackend();
  const backendFetch = globalThis.fetch;
  const offsets = [];
  let failed = false;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === 'https://api.telegram.org/botsynthetic-test-token/getUpdates') {
      offsets.push(JSON.parse(options.body).offset);
      const result = offsets.length === 1 ? [transactionUpdate(5001), transactionUpdate(5002)]
        : offsets.length === 2 ? [transactionUpdate(5002)] : [];
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }
    if (String(url).endsWith('/telegram/transactions') && JSON.parse(options.body).telegram_update_id === 5002 && !failed) {
      failed = true;
      throw new Error('synthetic connection failure');
    }
    return backendFetch(url, options);
  };
  await observePoll(poller);
  await poller.pollOnce();
  await poller.pollOnce();
  assert.deepEqual(offsets, [0, 5002, 5003]);
  assert.equal(mock.transactions.size, 2);
});

test('polling resets its offset after an extended period without updates', async () => {
  const poller = bot.createPoller();
  syntheticBackend();
  const backendFetch = globalThis.fetch;
  const offsets = [];
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === 'https://api.telegram.org/botsynthetic-test-token/getUpdates') {
      offsets.push(JSON.parse(options.body).offset);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: offsets.length === 1 ? [transactionUpdate(6001)] : [] }) };
    }
    return backendFetch(url, options);
  };
  try {
    await poller.pollOnce();
    now += 6 * 24 * 60 * 60 * 1000;
    await poller.pollOnce();
    await poller.pollOnce();
    assert.deepEqual(offsets, [0, 6002, 0]);
  } finally {
    Date.now = originalNow;
  }
});

async function observePoll(poller) {
  try {
    await poller.pollOnce();
  } catch {
    // Either propagating or handling the retryable error is acceptable here.
  }
}
