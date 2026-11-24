import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
process.env.BACKEND_URL = 'http://synthetic-backend.invalid';
const { handleUpdate, sendMessage } = await import('../src/bot.js');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function privateMessage(fields = {}) {
  return { chat: { id: 123, type: 'private' }, from: { id: 123, first_name: 'Test' }, ...fields };
}

function mockFetch(account = null) {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url: String(url), body });
    if (String(url).includes('/telegram/contact')) {
      return { ok: true, json: async () => ({
        otp: '123456', user: { is_verified: false, display_name: 'Test' },
        is_new_registration: true,
        admins: [{ telegram_chat_id: '-100123' }, { telegram_chat_id: '456' }],
      }) };
    }
    if (String(url).includes('/telegram/account')) {
      return account
        ? { ok: true, json: async () => ({ user: account }) }
        : { status: 404 };
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  return requests;
}

test('ignores nonprivate, malformed, and callback updates before any network request', async () => {
  const requests = mockFetch();
  for (const type of ['group', 'supergroup', 'channel', undefined]) {
    for (const fields of [{ text: '/mulai' }, { text: '/ringkasan' }, { text: '/admin_user' },
      { contact: { user_id: 123, phone_number: '081234' } }]) {
      await handleUpdate({ message: privateMessage({ chat: { id: -100123, type }, ...fields }) });
    }
  }
  await handleUpdate({ message: privateMessage({ chat: { id: 123, type: 'group' }, text: '/mulai' }) });
  await handleUpdate({ message: privateMessage({ chat: { id: -123, type: 'private' }, text: '/mulai' }) });
  await handleUpdate({ message: privateMessage({ chat: { id: 456, type: 'private' }, text: '/mulai' }) });
  await handleUpdate({ message: { chat: { id: 123, type: 'private' }, text: '/mulai' } });
  for (const type of ['private', 'group']) {
    await handleUpdate({ callback_query: { from: { id: 123 }, message: { chat: { id: 123, type } }, data: 'sensitive' } });
  }
  assert.equal(requests.length, 0);
});

test('rejects contacts without the sender identity or belonging to someone else', async () => {
  const requests = mockFetch();
  for (const userId of [undefined, null, 0, 456, '123']) {
    await handleUpdate({ message: privateMessage({ contact: { user_id: userId, phone_number: '081234' } }) });
  }
  assert.equal(requests.length, 5);
  assert.ok(requests.every((request) => request.url.endsWith('/sendMessage')));
  assert.ok(requests.every((request) => request.body.text.includes('nomor Telegram milik kamu sendiri')));
});

test('links a matching private contact and blocks legacy group admin notifications', async () => {
  const requests = mockFetch();
  await handleUpdate({ message: privateMessage({ contact: { user_id: 123, phone_number: '081234' } }) });
  const contactRequest = requests.find((request) => request.url.endsWith('/telegram/contact'));
  assert.equal(contactRequest.body.telegram_user_id, '123');
  assert.equal(contactRequest.body.telegram_chat_id, '123');
  const messages = requests.filter((request) => request.url.endsWith('/sendMessage'));
  assert.deepEqual(messages.map((request) => String(request.body.chat_id)).sort(), ['123', '456']);
  assert.match(messages.find((request) => request.body.chat_id === 123).body.text, /Jangan bagikan kode OTP/);
});

test('outbound messages reject group and invalid IDs, including attempts to override the destination', async () => {
  const requests = mockFetch();
  for (const id of [-123, '-100123', 0, '@group', '1e3', null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(sendMessage(id, 'private data'));
  }
  await sendMessage('123', 'private data', { chat_id: '-100123' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.chat_id, '123');
});

test('blocked and disabled account messages provide support and OTP guidance', async () => {
  for (const [account, command] of [
    [{ is_blocked: true }, '/mulai'],
    [{ is_blocked: true }, '/ringkasan'],
    [{ is_deleted: true }, '/mulai'],
    [{ is_deleted: true }, '/ringkasan'],
  ]) {
    const requests = mockFetch(account);
    await handleUpdate({ message: privateMessage({ text: command }) });
    const message = requests.find((request) => request.url.endsWith('/sendMessage'));
    assert.match(message.body.text, /Ketik \/tentang untuk melihat kontak admin\. Jangan kirim kode OTP kepada siapa pun\./);
  }
});

test('private /tentang remains accessible to blocked users', async () => {
  const requests = mockFetch({ is_blocked: true });
  await handleUpdate({ message: privateMessage({ text: '/tentang' }) });
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.text, /Admin Budgetin:/);
});

test('registered private users can still record transactions', async () => {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const request = { url: String(url), body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    if (request.url.includes('/telegram/account')) {
      return { ok: true, json: async () => ({ user: { is_verified: true } }) };
    }
    if (request.url.endsWith('/telegram/transactions')) {
      return { ok: true, json: async () => ({ data: { type: 'expense', amount: 18000, category_label: 'Makan' } }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await handleUpdate({ message: privateMessage({ text: '/makan nasi 18000' }) });
  assert.equal(requests.find((request) => request.url.endsWith('/telegram/transactions')).body.telegram_user_id, '123');
  assert.match(requests.find((request) => request.url.endsWith('/sendMessage')).body.text, /Tersimpan/);
});
