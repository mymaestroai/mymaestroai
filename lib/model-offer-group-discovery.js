'use strict';

// The existing discovery job writes discovered-models.json after every scan (including manual
// rediscovery). Watch that cache and process its current contents once on startup as well.
function startGroupDiscovery({ file, scan, watch = require('fs').watchFile, log = console.error }) {
  let running;
  let queued = false;
  function refresh() {
    if (running) {
      queued = true;
      return running;
    }
    running = (async () => {
      do {
        queued = false;
        try { await Promise.resolve().then(scan); }
        catch (e) { log('[model-offer-groups] Discovery failed:', e.message); }
      } while (queued);
      running = null;
    })();
    return running;
  }
  watch(file, { persistent: false }, refresh);
  return refresh();
}

module.exports = { startGroupDiscovery };
