import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Extract only the functions under test: importing server.js starts migrations and workers.
const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing source boundary: ${start} / ${end}`);
  return source.slice(first, last);
}

function loadSubject({ query = async () => { throw new Error('Unexpected query'); }, redis } = {}) {
  const cache = redis || {
    get: async () => null,
    set: async () => {},
    keys: async () => [],
    del: async () => {},
  };
  const context = vm.createContext({ query, redis: cache });
  const declarations = [
    "const appTimeZone = 'Asia/Jakarta';",
    section('const CATEGORY_DEFINITIONS =', 'const corsOrigins ='),
    section('async function invalidateSummaryCache(', 'async function inTransaction('),
    section('function normalizeInput(', 'function normalizeCustomCategoryName('),
    section('function normalizeCustomCategoryName(', 'function isValidCategoryType('),
    section('function validateTransaction(', 'function transactionOrder('),
    section('function withCategoryLabels(', 'function sanitizeFilenamePart('),
    section('async function getSummaryForUser(', 'function deletionTypeLabel('),
    'globalThis.subject = { buildTransactionFilters, formatExportDate, updateTransactionForUser, getSummaryForUser, buildTransactionsCsv };',
  ].join('\n');
  vm.runInContext(declarations, context, { filename: 'isolated-server-functions.js' });
  return context.subject;
}

test('WIB filters bind account and use inclusive start and exclusive end', () => {
  const { buildTransactionFilters } = loadSubject();
  for (const [input, expected, interval] of [
    [{ date: '2024-02-29' }, ['2024-02-29', '2024-02-29'], '1 day'],
    [{ date: '2025-01-01' }, ['2025-01-01', '2025-01-01'], '1 day'],
    [{ month: '2024-02' }, ['2024-02-01', '2024-02-01'], '1 month'],
    [{ month: '2024-12' }, ['2024-12-01', '2024-12-01'], '1 month'],
    [{ date_from: '2024-12-31', date_to: '2025-01-01' }, ['2024-12-31', '2025-01-01'], '1 day'],
  ]) {
    const result = buildTransactionFilters('account-a', input);
    assert.deepEqual(Array.from(result.params), ['account-a', ...expected]);
    assert.match(result.where, /user_id = \$1/);
    assert.match(result.where, /created_at >= \(\$2::date::timestamp AT TIME ZONE 'Asia\/Jakarta'\)/);
    assert.ok(result.where.includes(`created_at < (($3::date + INTERVAL '${interval}') AT TIME ZONE 'Asia/Jakarta')`));
  }
});

test('CSV date formatting crosses midnight, leap day and year in WIB', () => {
  const { formatExportDate } = loadSubject();
  for (const [utc, expected] of [
    ['2024-02-28T16:59:59Z', '24/02/28 23:59:59'],
    ['2024-02-28T17:00:00Z', '24/02/29 00:00:00'],
    ['2024-02-29T17:00:00Z', '24/03/01 00:00:00'],
    ['2024-12-31T16:59:59Z', '24/12/31 23:59:59'],
    ['2024-12-31T17:00:00Z', '25/01/01 00:00:00'],
  ]) assert.equal(formatExportDate(utc), expected);
});

test('CSV export passes the owner and WIB filter to the query', async () => {
  const calls = [];
  const subject = loadSubject({ query: async (sql, params) => {
    calls.push({ sql, params: Array.from(params) });
    return { rows: [{ created_at: '2024-12-31T17:00:00Z', type: 'income', category: 'salary', amount: 100, note: 'synthetic' }] };
  } });
  const csv = await subject.buildTransactionsCsv('account-a', { date: '2025-01-01' });
  assert.deepEqual(calls[0].params, ['account-a', '2025-01-01', '2025-01-01']);
  assert.match(calls[0].sql, /user_id = \$1/);
  assert.match(calls[0].sql, /AT TIME ZONE 'Asia\/Jakarta'/);
  assert.match(csv, /25\/01\/01 00:00:00,income,salary/);
});

test('update binds both transaction ID and owner, and reports a missing row', async () => {
  const calls = [];
  const subject = loadSubject({ query: async (sql, params) => {
    calls.push({ sql, params: Array.from(params) });
    return { rows: [] };
  } });
  const result = await subject.updateTransactionForUser('account-b', 'transaction-a', {
    type: 'expense', amount: 100, category: 'food_drink', note: 'synthetic',
  });
  assert.equal(result.status, 404);
  assert.match(calls[0].sql, /WHERE id = \$1\s+AND user_id = \$2/);
  assert.deepEqual(calls[0].params.slice(0, 2), ['transaction-a', 'account-b']);
});

test('delete binds transaction ID and owner and returns 404 for a missing row', async () => {
  let handler;
  const calls = [];
  const context = vm.createContext({
    app: { delete: (_path, ...handlers) => { handler = handlers.at(-1); } },
    authRequired: () => {},
    webFeatureRequired: () => {},
    query: async (sql, params) => {
      calls.push({ sql, params: Array.from(params) });
      return { rows: [] };
    },
  });
  vm.runInContext(section("app.delete('/transactions/:id'", "app.get('/analytics/summary'"), context);
  let status;
  let body;
  const res = {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  await handler({ params: { id: 'transaction-a' }, user: { id: 'account-b' } }, res);
  assert.equal(status, 404);
  assert.equal(body.error, 'Transaksi tidak ditemukan');
  assert.match(calls[0].sql, /WHERE id = \$1 AND user_id = \$2/);
  assert.deepEqual(calls[0].params, ['transaction-a', 'account-b']);
});

test('summary totals query does not apply the 500-row list limit', async () => {
  const calls = [];
  const subject = loadSubject({ query: async (sql, params) => {
    calls.push({ sql, params: Array.from(params) });
    return { rows: sql.includes('GROUP BY') ? [] : [{ income: 501, expense: 0 }] };
  } });
  const summary = await subject.getSummaryForUser('account-a', { month: '2024-12' });
  assert.equal(summary.income, 501);
  assert.match(calls[0].sql, /SUM\(amount\)/);
  assert.doesNotMatch(calls[0].sql, /\bLIMIT\b/i);
  assert.deepEqual(calls[0].params, ['account-a', '2024-12-01', '2024-12-01']);
});

test('summary cache is isolated between synthetic accounts', async () => {
  const entries = new Map();
  const redis = {
    get: async (key) => entries.get(key) || null,
    set: async (key, value) => entries.set(key, value),
  };
  const subject = loadSubject({ redis, query: async (sql, params) => ({ rows:
    sql.includes('GROUP BY') ? [] : [{ income: params[0] === 'account-a' ? 100 : 200, expense: 0 }],
  }) });
  assert.equal((await subject.getSummaryForUser('account-a', { month: '2024-12' })).income, 100);
  assert.equal((await subject.getSummaryForUser('account-b', { month: '2024-12' })).income, 200);
  assert.equal(entries.size, 2);
});

test('summary cache distinguishes different filters in the same month', async () => {
  const entries = new Map();
  const redis = {
    get: async (key) => entries.get(key) || null,
    set: async (key, value) => entries.set(key, value),
  };
  const subject = loadSubject({ redis, query: async (sql, params) => ({ rows:
    sql.includes('GROUP BY') ? [] : [{ income: params.includes('income') ? 100 : 0, expense: params.includes('expense') ? 50 : 0 }],
  }) });
  const income = await subject.getSummaryForUser('account-a', { month: '2024-12', type: 'income' });
  const expense = await subject.getSummaryForUser('account-a', { month: '2024-12', type: 'expense' });
  assert.equal(income.income, 100);
  assert.equal(expense.income, 0);
  assert.equal(expense.expense, 50);
});
