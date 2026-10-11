// Register cache work with the request lifetime before returning. Without a
// working execution context, retain the awaited behavior rather than abandoning
// the write. Both synchronous throws and rejected writes remain best effort.
export async function runCacheWrite(write, ctx = {}) {
  const pending = Promise.resolve().then(write).catch(() => {});
  if (typeof ctx?.waitUntil === 'function') {
    try {
      ctx.waitUntil(pending);
      return true;
    } catch { /* A detached/test context may reject lifetime registration. */ }
  }
  await pending;
  return false;
}
