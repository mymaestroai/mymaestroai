'use strict';
// The model offers the owner declined, one list of model ids per agent. Never overwrites a file it could not read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeId } = require('./model-offers');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_IDS = 50;
const BAD = { ok: false, error: 'Bad agent name or model id.' };
const UNREADABLE = { ok: false, error: 'The model offers file could not be read, so nothing changed.' };

function createOffersStore({ file } = {}) {
  const target = file || path.join(__dirname, '..', 'data', 'model-offers.json');

  function read() {
    let raw;
    try { raw = fs.readFileSync(target, 'utf8'); }
    catch (e) { return e && e.code === 'ENOENT' ? { declined: Object.create(null) } : { declined: Object.create(null), unreadable: true }; }
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object' || Array.isArray(j) || !j.declined || typeof j.declined !== 'object' || Array.isArray(j.declined)) throw new Error('shape');
      const declined = Object.create(null);   // no prototype: agent names such as "constructor" or a "__proto__" key stay plain keys
      for (const [k, v] of Object.entries(j.declined)) {
        if (!Array.isArray(v)) throw new Error('shape');
        declined[k] = v.filter((x) => typeof x === 'string');
      }
      if (!Object.hasOwn(j, 'receipts')) return { declined };
      if (!j.receipts || typeof j.receipts !== 'object' || Array.isArray(j.receipts) ||
          Object.entries(j.receipts).some(([token, name]) => !/^[a-f0-9]{64}$/.test(token) ||
            typeof name !== 'string' || !NAME_RE.test(name))) throw new Error('receipt shape');
      return { declined, receipts: j.receipts };
    } catch { return { declined: Object.create(null), unreadable: true }; }
  }

  function write(data) {
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, target);
      return { ok: true };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* not written */ }
      return { ok: false, error: `The model offers file could not be written: ${e.message}` };
    }
  }

  function decline(name, model, receipt) {
    if (receipt !== undefined && (typeof receipt !== 'string' || !/^[a-f0-9]{64}$/.test(receipt))) return { ...BAD };
    if (typeof name !== 'string' || !NAME_RE.test(name) || !safeId(model)) return { ...BAD };
    const cur = read();
    if (cur.unreadable) return { ...UNREADABLE };
    const list = (cur.declined[name] || []).filter((x) => x !== model);
    list.push(model);
    cur.declined[name] = list.slice(-MAX_IDS);
    if (receipt) (cur.receipts ||= {})[receipt] = name;
    return write(cur);
  }

  function forget(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { ...BAD };
    const cur = read();
    if (cur.unreadable) return { ...UNREADABLE };
    if (!(name in cur.declined)) return { ok: true };
    delete cur.declined[name];
    for (const [token, agent] of Object.entries(cur.receipts || {})) {
      if (agent === name) delete cur.receipts[token];
    }
    return write(cur);
  }

  return { read, decline, forget, file: target };
}

module.exports = { createOffersStore };
