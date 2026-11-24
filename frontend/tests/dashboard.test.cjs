const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../app/page.jsx'), 'utf8');
function extract(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Tidak menemukan ${start}`);
  return source.slice(from, to);
}

const context = vm.createContext({ URLSearchParams, DOMException, Intl, Date, Map, Set, Number, String });
vm.runInContext([
  extract('function parseDate(', 'function formatDateTimeWib('),
  extract('function summarizeTransactions(', 'function totalForCategory('),
  extract('function buildTrend(', 'function categoryInsight('),
].join('\n') + '\nthis.helpers = { summarizeTransactions, filterHistory, groupBySubcategory, buildTrend, fetchAllTransactions };', context);
const { summarizeTransactions, filterHistory, groupBySubcategory, buildTrend, fetchAllTransactions } = context.helpers;

test('label bulan tetap WIB saat zona waktu perangkat berbeda', () => {
  const script = `${extract('function monthLabel(', 'function periodLabel(')}\nprocess.stdout.write(monthLabel('2026-12'));`;
  for (const zone of ['Pacific/Kiritimati', 'America/Adak']) {
    const label = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ: zone } });
    assert.equal(label, 'Desember 2026');
  }
});

function transaction(id, overrides = {}) {
  return { id, type: 'expense', amount: 2, category: 'food_drink', subcategory: 'Kopi', created_at: '2025-12-31T16:59:00Z', ...overrides };
}

test('memuat seluruh halaman untuk ringkasan dan subkategori', async () => {
  const data = Array.from({ length: 1201 }, (_, id) => transaction(id));
  const offsets = [];
  const result = await fetchAllTransactions(async (url) => {
    const params = new URL(url, 'http://localhost').searchParams;
    assert.equal(params.get('month'), '2025-12');
    assert.equal(params.get('sort'), 'oldest');
    const offset = Number(params.get('offset'));
    offsets.push(offset);
    return { data: data.slice(offset, offset + 500) };
  }, '2025-12', new AbortController().signal);
  assert.deepEqual(offsets, [0, 500, 1000]);
  assert.equal(summarizeTransactions(result).expense, 2402);
  assert.equal(summarizeTransactions(result).count, 1201);
  assert.equal(groupBySubcategory(result, 'expense', 'food_drink')[0].total, 2402);
});

test('tren bulanan diurutkan berdasarkan tahun-bulan WIB', () => {
  const trend = buildTrend([
    transaction(1, { created_at: '2026-01-31T17:00:00Z', amount: 3 }),
    transaction(2, { created_at: '2025-12-31T16:59:00Z', amount: 4 }),
    transaction(3, { created_at: '2025-12-31T17:00:00Z', amount: 5 }),
  ], 'monthly');
  assert.deepEqual(Array.from(trend, (item) => item.expense), [4, 5, 3]);
});

test('pencarian dan urutan riwayat tidak mengubah ringkasan', () => {
  const data = [transaction(1, { note: 'Kopi', amount: 7 }), transaction(2, { note: 'Makan', subcategory: '', amount: 3 })];
  const history = filterHistory(data, { type: '', category: '', subcategory: '', search: 'makan', sort: 'newest' });
  assert.equal(history.length, 1);
  assert.equal(history[0].id, 2);
  assert.equal(summarizeTransactions(data).expense, 10);
  assert.equal(groupBySubcategory(data, 'expense', 'food_drink').length, 2);
});

test('halaman duplikat dan respons gagal tidak menghasilkan ringkasan parsial', async () => {
  const page = Array.from({ length: 500 }, (_, id) => transaction(id));
  let calls = 0;
  await assert.rejects(fetchAllTransactions(async () => { calls++; return { data: page }; }, '', new AbortController().signal), /tidak konsisten/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(fetchAllTransactions(async () => {
    if (++calls === 1) return { data: page };
    throw new Error('gagal');
  }, '', new AbortController().signal), /gagal/);
  assert.equal(calls, 2);
});

test('pembatalan menghentikan pemuatan halaman berikutnya', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchAllTransactions(async () => {
    calls++;
    controller.abort();
    return { data: Array.from({ length: 500 }, (_, id) => transaction(id)) };
  }, '', controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});
