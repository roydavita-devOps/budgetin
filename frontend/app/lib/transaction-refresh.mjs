export function startTransactionRefresh({ run, onError, documentRef, intervalMs = 20_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false;
  let timer = null;
  let active = null;
  let pending = false;
  let failures = 0;

  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    if (stopped || documentRef.visibilityState !== 'visible') return;
    clearScheduled();
    const delay = Math.min(intervalMs * (2 ** Math.min(failures, 3)), 120_000);
    timer = setTimer(() => { timer = null; void refresh(); }, delay);
  }

  async function refresh() {
    if (stopped || documentRef.visibilityState !== 'visible') return;
    clearScheduled();
    if (active) {
      if (active.signal.aborted) pending = true;
      return;
    }
    const controller = new AbortController();
    active = controller;
    try {
      await run(controller.signal);
      if (!controller.signal.aborted) failures = 0;
    } catch (error) {
      if (!controller.signal.aborted && !stopped) {
        failures += 1;
        onError(error);
        controller.abort();
      }
    } finally {
      active = null;
      if (stopped) return;
      if (pending && documentRef.visibilityState === 'visible') {
        pending = false;
        void refresh();
      } else {
        pending = false;
        schedule();
      }
    }
  }

  function onVisibilityChange() {
    if (documentRef.visibilityState === 'visible') {
      void refresh();
    } else {
      clearScheduled();
      pending = false;
      active?.abort();
    }
  }

  documentRef.addEventListener('visibilitychange', onVisibilityChange);
  void refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      clearScheduled();
      active?.abort();
      documentRef.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
