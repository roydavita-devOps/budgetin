const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/page.jsx'), 'utf8');
const from = source.indexOf('  async function clearSession(');
const to = source.indexOf('  async function loadCategories()', from);
assert.ok(from >= 0 && to > from);
const functions = source.slice(from, to);
const inactiveMessage = source.match(/const inactiveMessage = '([^']+)'/)[1];

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function harness(fetch) {
  const state = { token: 'old-token', user: { id: 1 }, transactions: ['old'], monthly: ['old'], categories: ['old'], authMessage: '', inactive: false };
  const storage = new Map([['budgetin_session', 'old-session']]);
  const context = vm.createContext({
    fetch, state, inactiveMessage, apiUrl: '/api', storageKey: 'budgetin_session',
    token: 'old-token', phoneNumber: '08123456789', otpCode: '123456',
    refreshPromiseRef: { current: null }, sessionGenerationRef: { current: 0 },
    sessionStorage: { removeItem: (key) => storage.delete(key), setItem: (key, value) => storage.set(key, value) },
    setToken: (value) => { state.token = value; },
    setUser: (value) => { state.user = value; },
    setTransactions: (value) => { state.transactions = value; },
    setMonthlyTrendTransactions: (value) => { state.monthly = value; },
    setCustomCategories: (value) => { state.categories = value; },
    setAuthMessage: (value) => { state.authMessage = value; },
    setIsInactive: (value) => { state.inactive = value; },
    setOtpCode: () => {}, setEditingTransaction: () => {}, setIsBulkSelectMode: () => {},
    setSelectedTransactionIds: () => {}, setIsBulkEditModalOpen: () => {}, setIsCategoryModalOpen: () => {},
    setIsSubcategoryDrawerOpen: () => {}, setIsSubcategoryTransactionsModalOpen: () => {},
  });
  vm.runInContext(`${functions}\nthis.api = { request, refreshSession, requestOtp, verifyOtp };`, context);
  return { ...context.api, state, storage };
}

function assertInactive(h) {
  assert.equal(h.state.inactive, true);
  assert.equal(h.state.token, '');
  assert.equal(h.state.user, null);
  assert.equal(h.state.transactions.length, 0);
  assert.equal(h.state.monthly.length, 0);
  assert.equal(h.state.categories.length, 0);
  assert.equal(h.storage.has('budgetin_session'), false);
  assert.match(h.state.authMessage, /30 hari/);
  assert.match(h.state.authMessage, /Telegram.*pertahankan atau hapus/);
  assert.match(h.state.authMessage, /belum tiba.*\/tentang.*admin/);
}

for (const method of ['requestOtp', 'verifyOtp']) {
  test(`${method} menampilkan petunjuk akun nonaktif`, async () => {
    const h = harness(async () => response(403, { code: 'ACCOUNT_INACTIVE', error: 'internal message' }));
    await h[method]();
    assertInactive(h);
  });
}

test('respons OTP generik tidak dianggap sebagai akun nonaktif', async () => {
  const h = harness(async () => response(200, { message: 'Jika nomor terdaftar, periksa Telegram.' }));
  await h.requestOtp();
  assert.equal(h.state.authMessage, 'Jika nomor terdaftar, periksa Telegram.');
  assert.equal(h.state.inactive, false);
  assert.equal(h.storage.has('budgetin_session'), true);
});

test('data dashboard nonaktif tidak mencoba refresh dan mengosongkan data lama', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return response(401, { code: 'ACCOUNT_INACTIVE' }); });
  await assert.rejects(h.request('/transactions'), { code: 'ACCOUNT_INACTIVE' });
  assert.equal(calls, 1);
  assertInactive(h);
});

test('refresh nonaktif mempertahankan pesan khusus', async () => {
  const h = harness(async (url) => url.endsWith('/auth/refresh')
    ? response(403, { code: 'ACCOUNT_INACTIVE' })
    : response(401, { error: 'expired' }));
  await assert.rejects(h.request('/me'), { code: 'ACCOUNT_INACTIVE' });
  assertInactive(h);
});

test('respons lama setelah inactive tidak mengembalikan data atau menimpa pesan', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const h = harness(async (url) => url.endsWith('/slow') ? pending : response(403, { code: 'ACCOUNT_INACTIVE' }));
  const oldRequest = h.request('/slow');
  await assert.rejects(h.request('/transactions'), { code: 'ACCOUNT_INACTIVE' });
  finish(response(200, { data: ['old'] }));
  await assert.rejects(oldRequest, { code: 'REQUEST_SUPERSEDED' });
  assertInactive(h);
});

test('kegagalan jaringan request lama tidak menimpa status inactive', async () => {
  let fail;
  const pending = new Promise((resolve, reject) => { fail = reject; });
  const h = harness(async (url) => url.endsWith('/auth/request-otp') ? pending : response(403, { code: 'ACCOUNT_INACTIVE' }));
  const oldRequest = h.requestOtp();
  await assert.rejects(h.request('/transactions'), { code: 'ACCOUNT_INACTIVE' });
  fail(new Error('Network error'));
  await oldRequest;
  assertInactive(h);
});

test('refresh lama tidak memulihkan sesi setelah respons inactive lain', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const h = harness(async (url) => url.endsWith('/auth/refresh') ? pending : response(403, { code: 'ACCOUNT_INACTIVE' }));
  const oldRefresh = h.refreshSession();
  await assert.rejects(h.request('/transactions'), { code: 'ACCOUNT_INACTIVE' });
  finish(response(200, { token: 'new-token', user: { id: 1 } }));
  await assert.rejects(oldRefresh, { code: 'REQUEST_SUPERSEDED' });
  assertInactive(h);
});

test('error lain tetap menggunakan pesan API dan refresh biasa tetap berjalan', async () => {
  const h = harness(async (url) => {
    if (url.endsWith('/auth/request-otp')) return response(400, { error: 'Nomor tidak valid' });
    if (url.endsWith('/auth/refresh')) return response(200, { token: 'new-token', user: { id: 1 } });
    return response(401, { error: 'expired' });
  });
  await h.requestOtp();
  assert.equal(h.state.authMessage, 'Nomor tidak valid');
  await assert.rejects(h.request('/me'), /expired/);
  assert.equal(h.state.token, 'new-token');
  assert.equal(h.state.inactive, false);
});
