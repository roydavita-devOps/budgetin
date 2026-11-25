import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
process.env.BACKEND_URL = 'http://synthetic-backend.invalid';
const { handleUpdate } = await import('../src/bot.js');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const transactions = [1, 2, 3].map((id) => ({
  id, type: 'expense', amount: id * 1000, category_label: 'Test', note: 'synthetic',
}));

function setup(id, deleteResponse = async (transaction) => ({ ok: true, json: async () => ({ data: transaction }) })) {
  const requests = [];
  let history = transactions;
  let failNextMessage = false;
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    requests.push({ address, options });
    if (address.startsWith('http://synthetic-backend.invalid/telegram/account')) {
      return { ok: true, json: async () => ({ user: { is_verified: true } }) };
    }
    if (address.startsWith('http://synthetic-backend.invalid/telegram/transactions?')) {
      return { ok: true, json: async () => ({ data: history }) };
    }
    if (address.startsWith('http://synthetic-backend.invalid/telegram/transactions/') && options.method === 'DELETE') {
      const transactionId = Number(new URL(address).pathname.split('/').at(-1));
      return deleteResponse(transactions.find((item) => item.id === transactionId));
    }
    if (address === 'https://api.telegram.org/botsynthetic-test-token/sendMessage') {
      if (failNextMessage) {
        failNextMessage = false;
        throw new Error('synthetic send failure');
      }
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
    throw new Error(`Unexpected mocked request: ${address}`);
  };
  return {
    send: (text) => handleUpdate({ message: { chat: { id, type: 'private' }, from: { id }, text } }),
    setHistory: (value) => { history = value; },
    failNextMessage: () => { failNextMessage = true; },
    deletes: () => requests.filter((request) => request.options.method === 'DELETE'),
    messages: () => requests.filter((request) => request.address.endsWith('/sendMessage'))
      .map((request) => JSON.parse(request.options.body).text),
  };
}

test('rejects malformed, duplicate, and extra deletion arguments without deleting', async () => {
  const bot = setup(1001);
  await bot.send('/riwayat');
  for (const input of ['1,garbage', '1,', ',1', '1,,2', '1,0', '1,1', '1e0', '1 2', '9007199254740992']) {
    await bot.send(`/hapus ${input}`);
    await bot.send(`/konfirmasi_hapus ${input}`);
  }
  assert.equal(bot.deletes().length, 0);
  await bot.send('/hapus 1,2');
  await bot.send('/konfirmasi_hapus 1,2 extra');
  assert.equal(bot.deletes().length, 0);
  await bot.send('/konfirmasi_hapus 1,2');
  assert.equal(bot.deletes().length, 2);
  assert.match(bot.messages().at(-1), /2 transaksi sudah dihapus/);
});

for (const failure of ['network', 'http', 'invalid-json', 'wrong-id']) {
  test(`reports partial deletion and invalidates confirmation after ${failure} failure`, async () => {
    const bot = setup(1010 + ['network', 'http', 'invalid-json', 'wrong-id'].indexOf(failure), async (transaction) => {
      if (transaction.id !== 2) return { ok: true, json: async () => ({ data: transaction }) };
      if (failure === 'network') throw new Error('network failure');
      if (failure === 'http') return { ok: false, status: 500 };
      if (failure === 'invalid-json') return { ok: true, json: async () => { throw new Error('invalid json'); } };
      return { ok: true, json: async () => ({ data: { id: 99 } }) };
    });
    await bot.send('/riwayat');
    await bot.send('/hapus 1,2,3');
    await bot.send('/konfirmasi_hapus 1,2,3');
    assert.equal(bot.deletes().length, 2);
    assert.match(bot.messages().at(-1), /1 transaksi terkonfirmasi dihapus/);
    assert.match(bot.messages().at(-1), /Status 1 transaksi yang dicoba terakhir belum pasti/);
    assert.match(bot.messages().at(-1), /1 transaksi lainnya belum dicoba/);
    await bot.send('/konfirmasi_hapus 1,2,3');
    await bot.send('/hapus 3');
    assert.equal(bot.deletes().length, 2);
  });
}

test('new empty history invalidates old selection and confirmation', async () => {
  const bot = setup(1020);
  await bot.send('/riwayat');
  await bot.send('/hapus 1,2');
  bot.setHistory([]);
  await bot.send('/riwayat 2');
  await bot.send('/konfirmasi_hapus 1,2');
  await bot.send('/hapus 1');
  assert.equal(bot.deletes().length, 0);
});

test('single deletion clears a previous bulk confirmation', async () => {
  const bot = setup(1021);
  await bot.send('/riwayat');
  await bot.send('/hapus 1,2');
  await bot.send('/hapus 3');
  assert.match(bot.messages().at(-1), /Dihapus:/);
  await bot.send('/konfirmasi_hapus 1,2');
  assert.equal(bot.deletes().length, 1);
});

test('a history list that failed to send cannot be used for deletion', async () => {
  const bot = setup(1022);
  await bot.send('/riwayat');
  await bot.send('/hapus 1,2');
  bot.setHistory([transactions[2]]);
  bot.failNextMessage();
  await bot.send('/riwayat');
  await bot.send('/hapus 1');
  await bot.send('/konfirmasi_hapus 1,2');
  assert.equal(bot.deletes().length, 0);
});

test('account deactivation reports unsuccessful admin notification without claiming failure of the deactivation', async () => {
  const messages = [];
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    if (address.startsWith('http://synthetic-backend.invalid/telegram/account')) {
      return { ok: true, json: async () => ({ user: { is_verified: true } }) };
    }
    if (address.startsWith('http://synthetic-backend.invalid/telegram/deletion-requests/') && options.method === 'PATCH') {
      return { ok: true, json: async () => ({
        request: { request_code: 'ABC123' },
        user: { delete_recovery_until: '2026-11-27T12:00:00Z' },
        admins: [{ telegram_chat_id: '2001' }],
        telegram: { telegram_user_id: '1023' },
      }) };
    }
    if (address.endsWith('/sendMessage')) {
      const message = JSON.parse(options.body);
      if (String(message.chat_id) === '2001') throw new Error('synthetic send failure');
      messages.push(message.text);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error(`Unexpected mocked request: ${address}`);
  };
  await handleUpdate({ message: { chat: { id: 1023, type: 'private' }, from: { id: 1023 }, text: '/konfirmasi_hapus_akun ABC123' } });
  assert.match(messages.at(-1), /akun Budgetin kamu sudah dinonaktifkan/i);
  assert.match(messages.at(-1), /Notifikasi ke admin belum terkirim/);
  assert.doesNotMatch(messages.at(-1), /^Gagal:/);
});
