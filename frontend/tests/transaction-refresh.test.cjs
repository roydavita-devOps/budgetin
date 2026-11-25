const test = require('node:test');
const assert = require('node:assert/strict');

const loadLoop = () => import('../app/lib/transaction-refresh.mjs');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeEnvironment() {
  const callbacks = new Map();
  const listeners = new Set();
  let nextId = 0;
  const documentRef = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => { if (name === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (name, fn) => { if (name === 'visibilitychange') listeners.delete(fn); },
    setVisibility(value) { this.visibilityState = value; for (const fn of listeners) fn(); },
  };
  return {
    documentRef,
    setTimer: (fn, delay) => { const id = ++nextId; callbacks.set(id, { fn, delay }); return id; },
    clearTimer: (id) => callbacks.delete(id),
    timers: () => [...callbacks.values()],
    fire: () => { const [id, value] = callbacks.entries().next().value; callbacks.delete(id); value.fn(); },
    listenerCount: () => listeners.size,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('refresh berjalan berurutan setiap 20 detik dan berhenti saat dibersihkan', async () => {
  const { startTransactionRefresh } = await loadLoop();
  const env = fakeEnvironment();
  let calls = 0;
  const loop = startTransactionRefresh({ ...env, run: async () => { calls += 1; }, onError: assert.fail });
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(env.timers().map((timer) => timer.delay), [20_000]);
  env.fire();
  await flush();
  assert.equal(calls, 2);
  loop.stop();
  assert.equal(env.timers().length, 0);
  assert.equal(env.listenerCount(), 0);
});

test('tab tersembunyi membatalkan request dan memuat kembali saat terlihat tanpa tumpang tindih', async () => {
  const { startTransactionRefresh } = await loadLoop();
  const env = fakeEnvironment();
  const first = deferred();
  const signals = [];
  const loop = startTransactionRefresh({ ...env, run: (signal) => { signals.push(signal); return signals.length === 1 ? first.promise : Promise.resolve(); }, onError: assert.fail });
  assert.equal(signals.length, 1);
  env.documentRef.setVisibility('hidden');
  assert.equal(signals[0].aborted, true);
  assert.equal(env.timers().length, 0);
  env.documentRef.setVisibility('visible');
  assert.equal(signals.length, 1);
  first.resolve();
  await flush();
  assert.equal(signals.length, 2);
  loop.stop();
});

test('kegagalan dijadwalkan ulang dengan jeda lebih panjang dan pulih setelah berhasil', async () => {
  const { startTransactionRefresh } = await loadLoop();
  const env = fakeEnvironment();
  let calls = 0;
  let errors = 0;
  const loop = startTransactionRefresh({ ...env, run: async () => { if (++calls === 1) throw new Error('offline'); }, onError: () => { errors += 1; } });
  await flush();
  assert.equal(errors, 1);
  assert.equal(env.timers()[0].delay, 40_000);
  env.fire();
  await flush();
  assert.equal(calls, 2);
  assert.equal(env.timers()[0].delay, 20_000);
  loop.stop();
});

test('stop membatalkan request dan mencegah error atau timer setelah unmount', async () => {
  const { startTransactionRefresh } = await loadLoop();
  const env = fakeEnvironment();
  const first = deferred();
  let signal;
  let errors = 0;
  const loop = startTransactionRefresh({ ...env, run: (value) => { signal = value; return first.promise; }, onError: () => { errors += 1; } });
  loop.stop();
  assert.equal(signal.aborted, true);
  first.reject(new Error('late failure'));
  await flush();
  assert.equal(errors, 0);
  assert.equal(env.timers().length, 0);
  assert.equal(env.listenerCount(), 0);
});

test('permintaan manual saat polling masih aktif tidak memulai request kedua', async () => {
  const { startTransactionRefresh } = await loadLoop();
  const env = fakeEnvironment();
  const first = deferred();
  let calls = 0;
  const loop = startTransactionRefresh({ ...env, run: () => { calls += 1; return first.promise; }, onError: assert.fail });
  await loop.refresh();
  assert.equal(calls, 1);
  first.resolve();
  await flush();
  assert.equal(env.timers().length, 1);
  loop.stop();
});
