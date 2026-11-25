import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
process.env.BACKEND_URL = 'http://synthetic-backend.invalid';
const { handleUpdate } = await import('../src/bot.js');
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

function setup({ account = { is_verified: true }, contactUser = account, deadline = null } = {}) {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ address, body, method: options.method });
    if (address.includes('/telegram/account')) {
      return account ? { ok: true, json: async () => ({ user: account }) } : { status: 404 };
    }
    if (address.endsWith('/telegram/contact')) {
      return { ok: true, json: async () => ({ user: contactUser, otp: '123456', admins: [] }) };
    }
    if (address.endsWith('/telegram/deletion-requests') && options.method === 'POST') {
      return { ok: true, json: async () => ({ request: { request_code: 'ABC123' } }) };
    }
    if (address.endsWith('/telegram/deletion-requests/ABC123') && options.method === 'PATCH') {
      return { ok: true, json: async () => ({ request: { request_code: 'ABC123' }, user: { delete_recovery_until: deadline }, admins: [{ telegram_chat_id: '456' }] }) };
    }
    if (address.endsWith('/sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
    throw new Error(`Unexpected mocked request: ${address}`);
  };
  return {
    send: (fields) => handleUpdate({ message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, ...fields } }),
    messages: () => requests.filter(({ address }) => address.endsWith('/sendMessage')).map(({ body }) => body.text),
    requests,
  };
}

for (const [name, deadline, expected, expectedTime] of [
  ['before deadline', '2026-11-25T12:01:00Z', /Batas waktu pemulihan oleh admin: .*WIB\. Hubungi admin sebelum batas tersebut untuk meminta pemulihan\./, /25 Nov 2026, 19\.01\.00 WIB/],
  ['at deadline', '2026-11-25T12:00:00Z', /Batas waktu pemulihan oleh admin \(.*WIB\) sudah berakhir/, /25 Nov 2026, 19\.00\.00 WIB/],
  ['after deadline', '2026-11-25T11:59:00Z', /Batas waktu pemulihan oleh admin \(.*WIB\) sudah berakhir/, /25 Nov 2026, 18\.59\.00 WIB/],
  ['missing deadline', null, /Batas waktu pemulihan tidak tersedia/],
  ['invalid deadline', 'invalid-date', /Batas waktu pemulihan tidak tersedia/],
]) {
  test(`recovery guidance for ${name} in status and confirmation messages`, async () => {
    Date.now = () => Date.parse('2026-11-25T12:00:00Z');
    const bot = setup({ account: { is_deleted: true, delete_recovery_until: deadline }, deadline });
    await bot.send({ text: '/mulai' });
    // Confirmation is only reached while the account is active.
    const confirmBot = setup({ deadline });
    await confirmBot.send({ text: '/konfirmasi_hapus_akun ABC123' });
    for (const message of [bot.messages().at(-1), confirmBot.messages().at(-1)]) {
      assert.match(message, expected);
      assert.match(message, /\/tentang/);
      assert.doesNotMatch(message, /hapus permanen|dihapus otomatis/i);
      if (expectedTime) assert.match(message, expectedTime);
    }
  });
}

test('help and account deletion explain registration and confirmation', async () => {
  const bot = setup();
  await bot.send({ text: '/bantuan' });
  assert.match(bot.messages().at(-1), /terhubung dan aktif/);
  assert.match(bot.messages().at(-1), /Export memerlukan verifikasi admin/);
  await bot.send({ text: '/akun' });
  assert.match(bot.messages().at(-1), /Akun dinonaktifkan setelah konfirmasi/);
  await bot.send({ text: '/hapus_akun' });
  assert.match(bot.messages().at(-1), /Data kamu belum dihapus/);
  assert.match(bot.messages().at(-1), /\/konfirmasi_hapus_akun ABC123/);
  assert.equal(bot.requests.filter(({ method }) => method === 'PATCH').length, 0);
});

for (const status of ['is_deleted', 'is_blocked']) {
  test(`contact OTP does not promise account access when ${status}`, async () => {
    const bot = setup({ contactUser: { [status]: true, is_verified: true } });
    await bot.send({ contact: { user_id: 123, phone_number: '081234' } });
    const message = bot.messages().at(-1);
    assert.match(message, /Kode OTP Budgetin kamu: 123456/);
    assert.match(message, /Jangan bagikan kode OTP kepada siapa pun/);
    assert.match(message, /\/tentang/);
    assert.doesNotMatch(message, /mulai catat transaksi|Dashboard lengkap sudah aktif/);
  });
}
