const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/page.jsx'), 'utf8').replace(/\r\n/g, '\n');
function extract(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Tidak menemukan ${start}`);
  return source.slice(from, to);
}

const context = vm.createContext({});
vm.runInContext(`${extract('function categoriesForSession(', 'export default function Home()')}\nthis.categoriesForSession = categoriesForSession;`, context);
const categoriesForSession = context.categoriesForSession;

test('kategori akun lain atau data yang belum siap tidak tersedia', () => {
  const keyA = JSON.stringify(['token-a', 1]);
  const keyB = JSON.stringify(['token-b', 2]);
  const dataA = { key: keyA, items: [{ name: 'Kategori A' }] };
  assert.equal(categoriesForSession(dataA, keyA, true), dataA.items);
  assert.equal(categoriesForSession(dataA, keyB, true).length, 0);
  assert.equal(categoriesForSession(dataA, keyA, false).length, 0);
  assert.equal(categoriesForSession(dataA, keyB, false).length, 0);
});

function startCategoryLoad({ request, key, sessionKey, setData, setStatus }) {
  const effect = extract("  useEffect(() => {\n    if (!canViewDashboard) return;\n    const controller = new AbortController();\n    request('/categories'", '\n  useEffect(() => {\n    if (!isBulkSelectMode) return;');
  const run = new Function('useEffect', 'canViewDashboard', 'AbortController', 'request', 'headers', 'categorySessionKey', 'categoryKey', 'setCategoryData', 'setCategoryStatus', 'token', 'user', 'categoryVersion', effect);
  let cleanup;
  run((callback) => { cleanup = callback(); }, true, AbortController, request, {}, sessionKey, key, setData, setStatus, 'token', { id: 1 }, 0);
  return cleanup;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('kegagalan kategori tidak menyamar sebagai kosong dan retry menyimpan hasil', async () => {
  let data = { key: 'akun-a', items: [{ name: 'A' }] };
  let status;
  const setData = (value) => { data = value; };
  const setStatus = (value) => { status = value; };
  startCategoryLoad({ request: async () => { throw new Error('offline'); }, key: 'b-0', sessionKey: 'akun-b', setData, setStatus });
  await flush();
  assert.deepEqual(status, { key: 'b-0', error: 'offline' });
  assert.equal(categoriesForSession(data, 'akun-b', false).length, 0);
  startCategoryLoad({ request: async () => ({ custom: [{ name: 'B' }] }), key: 'b-1', sessionKey: 'akun-b', setData, setStatus });
  await flush();
  assert.deepEqual(status, { key: 'b-1', error: '' });
  assert.deepEqual(data, { key: 'akun-b', items: [{ name: 'B' }] });
  assert.equal(categoriesForSession(data, 'akun-b', true)[0].name, 'B');
});

test('respons lama yang dibatalkan tidak menimpa akun berikutnya', async () => {
  let resolveA;
  let data;
  let status;
  const setData = (value) => { data = value; };
  const setStatus = (value) => { status = value; };
  const cancelA = startCategoryLoad({ request: () => new Promise((resolve) => { resolveA = resolve; }), key: 'a-0', sessionKey: 'akun-a', setData, setStatus });
  cancelA();
  startCategoryLoad({ request: async () => ({ custom: [{ name: 'B' }] }), key: 'b-0', sessionKey: 'akun-b', setData, setStatus });
  await flush();
  resolveA({ custom: [{ name: 'A' }] });
  await flush();
  assert.equal(data.key, 'akun-b');
  assert.equal(data.items[0].name, 'B');
  assert.equal(status.key, 'b-0');
});

test('status kategori, coba ulang, dan pengaman edit terpasang pada UI', () => {
  const indicator = extract('function CategoryLoadStatus(', 'function StatusPanel(');
  assert.match(indicator, /role=\{error \? 'alert' : 'status'\}/);
  assert.match(indicator, /onClick=\{onRetry\}>Coba lagi/);
  assert.equal((source.match(/<CategoryLoadStatus ready=\{categoriesReady\} error=\{categoriesError\} onRetry=\{retryCategories\} \/>/g) || []).length, 3);
  assert.match(source, /if \(!editingTransaction \|\| !categoriesReady\) return;/);
  assert.match(source, /onClick=\{saveTransactionEdit\} disabled=\{!categoriesReady\}/);
  assert.match(source, /onClick=\{saveBulkTransactionEdit\}\s+disabled=\{!categoriesReady\}/);
  assert.match(source, /categoriesReady && \(modalCategoryList\.length/);
});
