'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();

// Only the current Tiger Team tool invocation can install this callback.
// Outside that scope ordinary tools retain their existing behavior.
function run(context, fn) { return storage.run(context, fn); }
function preserve(value, label) {
  const context = storage.getStore();
  if (!context) return value;
  try { context.preserve(value, label); }
  catch (cause) {
    throw Object.assign(new Error('Tiger Team artifact persistence failed: ' + cause.message, { cause }), { code: 'TT_PERSISTENCE_FAILED' });
  }
  return value;
}
module.exports = { run, preserve };
