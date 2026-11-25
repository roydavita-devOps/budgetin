const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/page.jsx'), 'utf8');
const start = source.indexOf('function filterHistory(');
const end = source.indexOf('function groupByCategory(', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ Date, Number });
vm.runInContext(`${source.slice(start, end)}\nthis.filterHistory = filterHistory;`, context);

function categoryChanged(filters, category) {
  const line = source.split('\n').find((item) => item.includes('id="history-category"'));
  const handler = line?.match(/onChange=\{(.*)\}>/)?.[1];
  assert.ok(handler, 'history category handler must exist');
  let result;
  const change = vm.runInNewContext(`(${handler})`, { filters, setFilters: (value) => { result = value; } });
  change({ target: { value: category } });
  return result;
}

for (const subcategory of ['Kopi', '__default__']) {
  test(`perubahan kategori menghapus filter sub-kategori ${subcategory}`, () => {
    const previous = { type: 'expense', category: 'other_expense', subcategory, sort: 'oldest', search: 'uji' };
    const next = categoryChanged(previous, 'food_drink');
    assert.equal(next.subcategory, '');
    assert.equal(next.category, 'food_drink');
    assert.equal(next.type, 'expense');
    assert.equal(next.sort, 'oldest');
    assert.equal(next.search, 'uji');
    const items = [{ type: 'expense', category: 'food_drink', subcategory: 'Nasi', note: 'uji', created_at: '2026-11-01T00:00:00Z' }];
    assert.equal(context.filterHistory(items, next).length, 1);
  });
}

test('pilihan semua kategori juga menghapus filter sub-kategori', () => {
  assert.equal(categoryChanged({ category: 'food_drink', subcategory: 'Kopi' }, '').subcategory, '');
});

test('filter sub-kategori aktif terlihat dan dapat dihapus sendiri', () => {
  assert.match(source, /aria-label="Filter sub-kategori aktif"/);
  assert.match(source, /filters\.subcategory === '__default__' \? 'Tanpa sub-kategori' : filters\.subcategory/);
  assert.match(source, /setFilters\(\{ \.\.\.filters, subcategory: '' \}\)/);
});
