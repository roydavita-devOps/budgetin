const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/page.jsx'), 'utf8');
const start = source.indexOf('  async function clearSession(');
const end = source.indexOf('  async function request(', start);
assert.ok(start >= 0 && end > start);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(fetchImpl) {
  const state = { token: 'old-token', user: { id: 'old-user' }, stored: null, calls: 0 };
  const generation = { current: 0 };
  const pending = { current: null };
  const context = vm.createContext({
    apiUrl: '/api', storageKey: 'session', sessionGenerationRef: generation, refreshPromiseRef: pending,
    fetch: (...args) => { state.calls += 1; return fetchImpl(...args); },
    sessionStorage: { removeItem: () => { state.stored = null; }, setItem: (_key, value) => { state.stored = JSON.parse(value); } },
    setToken: (value) => { state.token = value; }, setUser: (value) => { state.user = value; },
    setTransactions: () => {}, setOtpCode: () => {}, setAuthMessage: () => {},
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.handlers = { clearSession, refreshSession };`, context);
  return { state, generation, pending, ...context.handlers };
}

test('respons refresh terlambat tidak menghidupkan kembali sesi yang sudah dibersihkan', async () => {
  const response = deferred();
  const f = fixture(() => response.promise);
  const request = f.refreshSession();
  await f.clearSession();
  response.resolve({ ok: true, json: async () => ({ token: 'new-token', user: { id: 'old-user' } }) });
  assert.equal(await request, null);
  assert.equal(f.state.token, '');
  assert.equal(f.state.user, null);
  assert.equal(f.state.stored, null);
});

test('gangguan jaringan refresh tidak menghapus sesi', async () => {
  const f = fixture(async () => { throw new Error('offline'); });
  await assert.rejects(f.refreshSession(), /offline/);
  assert.equal(f.state.token, 'old-token');
  assert.equal(f.state.user.id, 'old-user');
});

test('refresh 401 membersihkan sesi yang sudah tidak valid', async () => {
  const f = fixture(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.equal(await f.refreshSession(), null);
  assert.equal(f.state.token, '');
  assert.equal(f.state.user, null);
});

test('refresh bersamaan memakai satu permintaan', async () => {
  const response = deferred();
  const f = fixture(() => response.promise);
  const first = f.refreshSession();
  const second = f.refreshSession();
  assert.equal(f.state.calls, 1);
  response.resolve({ ok: true, json: async () => ({ token: 'new-token', user: { id: 'old-user' } }) });
  await Promise.all([first, second]);
  assert.equal(f.state.token, 'new-token');
  assert.equal(f.state.stored.token, 'new-token');
});
