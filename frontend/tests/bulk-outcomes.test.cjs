const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/page.jsx'), 'utf8');
const start = source.indexOf('  async function saveBulkTransactionEdit()');
const end = source.indexOf('  async function createCustomCategory()', start);
assert.ok(start >= 0 && end > start, 'bulk handlers must exist');

function setup(rejectedIds) {
  const items = [
    { id: 'one', type: 'expense', amount: 100, category: 'food_drink', note: '' },
    { id: 'two', type: 'expense', amount: 200, category: 'food_drink', note: '' },
  ];
  const state = { transactions: items, trend: items, version: 0, selected: items.map((item) => item.id), bulk: true, closed: false, alerts: [] };
  const context = vm.createContext({
    selectedTransactions: items,
    selectedTransactionType: 'expense',
    categoriesReady: true,
    bulkEditForm: { category: 'transport', subcategory: '' },
    headers: {},
    window: { confirm: () => true, alert: (message) => state.alerts.push(message) },
    request: async (url, options) => {
      const id = url.split('/').at(-1);
      if (rejectedIds.includes(id)) throw new Error('synthetic connection lost');
      return options.method === 'PATCH' ? { data: { ...items.find((item) => item.id === id), category: 'transport' } } : {};
    },
    setTransactions: (fn) => { state.transactions = fn(state.transactions); },
    setMonthlyTrendTransactions: (fn) => { state.trend = fn(state.trend); },
    setDataVersion: (fn) => { state.version = fn(state.version); },
    setSelectedTransactionIds: (value) => { state.selected = value; },
    setIsBulkSelectMode: (value) => { state.bulk = value; },
    closeBulkEditModal: () => { state.closed = true; },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.handlers = { saveBulkTransactionEdit, deleteSelectedTransactions };`, context);
  return { state, ...context.handlers };
}

for (const [label, handler] of [['edit', 'saveBulkTransactionEdit'], ['delete', 'deleteSelectedTransactions']]) {
  for (const rejectedIds of [['two'], ['one', 'two']]) {
    test(`${label} memuat ulang dan memberi status belum pasti ketika ${rejectedIds.length} respons terputus`, async () => {
      const fixture = setup(rejectedIds);
      await fixture[handler]();
      assert.equal(fixture.state.version, 1);
      assert.equal(fixture.state.bulk, false);
      assert.equal(fixture.state.selected.length, 0);
      assert.equal(fixture.state.alerts.length, 1);
      assert.match(fixture.state.alerts[0], /belum dapat dipastikan/);
      assert.match(fixture.state.alerts[0], /Periksa Riwayat/);
      assert.doesNotMatch(fixture.state.alerts[0], /gagal/);
      if (handler === 'saveBulkTransactionEdit') assert.equal(fixture.state.closed, true);
    });
  }
}

function setupSingle(error) {
  const start = source.indexOf('  async function saveTransactionEdit()');
  const end = source.indexOf('  function toggleBulkSelectMode()', start);
  assert.ok(start >= 0 && end > start, 'single transaction handlers must exist');
  const state = { version: 0, closed: false, alerts: [] };
  const context = vm.createContext({
    editingTransaction: { id: 'one' },
    editForm: { type: 'expense', amount: '100', category: 'food_drink', subcategory: '', note: '' },
    categoriesReady: true,
    token: 'synthetic',
    headers: {},
    request: async () => { throw error; },
    window: { confirm: () => true, alert: (message) => state.alerts.push(message) },
    setTransactions: () => {},
    setMonthlyTrendTransactions: () => {},
    setDataVersion: (fn) => { state.version = fn(state.version); },
    cancelEditTransaction: () => { state.closed = true; },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.handlers = { saveTransactionEdit, deleteTransaction };`, context);
  return { state, ...context.handlers };
}

test('edit tunggal mempertahankan formulir saat validasi ditolak', async () => {
  const fixture = setupSingle(Object.assign(new Error('Nominal tidak valid'), { status: 400 }));
  await fixture.saveTransactionEdit();
  assert.equal(fixture.state.version, 0);
  assert.equal(fixture.state.closed, false);
  assert.match(fixture.state.alerts[0], /Nominal tidak valid/);
});

test('edit dan hapus tunggal memuat ulang ketika hasil belum pasti', async () => {
  for (const handler of ['saveTransactionEdit', 'deleteTransaction']) {
    const fixture = setupSingle(new Error('synthetic connection lost'));
    await fixture[handler]('one');
    assert.equal(fixture.state.version, 1);
    assert.match(fixture.state.alerts[0], /belum dapat dipastikan/);
    assert.match(fixture.state.alerts[0], /Periksa Riwayat/);
    if (handler === 'saveTransactionEdit') assert.equal(fixture.state.closed, true);
  }
});
