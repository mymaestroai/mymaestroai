'use strict';
// The process-wide call-recordings store: <hub home>/call-recordings, sealed with a key derived from the install key
// (data/.auth-key, created on first use exactly as two-factor does). Nothing is read or created until the first use.
const path = require('path');
const { createStore } = require('./store');
const { deriveKey } = require('./crypt');

let store = null;

function getStore() {
  if (store) return store;
  const { HUB_HOME } = require('../hub-home');
  const { getAuthKey } = require('../auth');
  store = createStore({ root: path.join(HUB_HOME, 'call-recordings'), key: deriveKey(getAuthKey()) });
  return store;
}

/** Tests: use this store from now on (null puts the real one back on the next getStore()). */
function setStoreForTests(s) { store = s || null; }

module.exports = { getStore, setStoreForTests };
