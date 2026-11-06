'use strict';
/**
 * backup/module-places.js — data connector modules that declare backup: true, as backup places of kind 'module'.
 * Each operation is a tool the module offers, called through the connectors (lib/connectors.js callTool):
 *   backup_put { file, name } → { name, size, md5 }     the module reads the local file itself
 *   backup_list {}            → { files: [{ name, size, created }] }
 *   backup_delete { name }    → { deleted }
 *   backup_get { name, out }  → { size, md5 }           the module writes the file to out
 * Every answer is text holding JSON (or an MCP result holding that text); it is checked here, and a failure is a plain error.
 *
 *   createModulePlaces({ modules, connectors, timeoutMs }) → { places(), put(id, file, name), list(id), remove(id, name), get(id, name, out) }
 *   getModulePlaces()   the one for the running hub
 */
const NAME = /^my-maestro-ai-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.age$/;
const isSize = (n) => Number.isSafeInteger(n) && n >= 0;
const isMd5 = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/i.test(s);

function createModulePlaces({ modules = null, connectors = null, timeoutMs = 3 * 3600 * 1000 } = {}) {
  const mods = () => modules || require('../modules').getModules();
  const conns = () => connectors || require('../connectors').getConnectors();
  const bad = (id, tool, why) => new Error(`${id}: ${tool} ${why}`);

  async function call(id, tool, args) {
    let r;
    try { r = await conns().callTool(id, tool, args, { timeoutMs }); }
    catch (e) { throw new Error(`${id}: ${tool} failed: ${(e && e.message) || e}`); }
    let text, isError = false;
    if (typeof r === 'string') text = r;
    else if (r && Array.isArray(r.content)) {
      isError = !!r.isError;
      text = r.content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
    } else throw bad(id, tool, 'gave no answer');
    if (isError) throw new Error(`${id}: ${tool} failed: ${text.trim().slice(0, 200) || 'no reason given'}`);
    let j;
    try { j = JSON.parse(text); } catch { throw bad(id, tool, `did not answer with JSON (${text.trim().slice(0, 120) || 'empty'})`); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw bad(id, tool, 'gave an answer in the wrong shape');
    return j;
  }
  const sizeMd5 = (id, tool, j) => {
    if (!isSize(j.size)) throw bad(id, tool, 'did not say how big the file is');
    if (!isMd5(j.md5)) throw bad(id, tool, 'did not give a checksum');
    return { size: j.size, md5: j.md5.toLowerCase() };
  };

  return {
    places() {
      try { return (mods().backupModules() || []).filter(m => m && m.id).map(m => ({ kind: 'module', id: String(m.id), label: String(m.label || m.id) })); }
      catch { return []; }
    },
    async put(id, file, name) {
      if (!NAME.test(String(name))) throw new Error('That is not a backup name.');
      const j = await call(id, 'backup_put', { file, name });
      if (j.name !== name) throw bad(id, 'backup_put', 'stored it under another name');
      return { name, ...sizeMd5(id, 'backup_put', j) };
    },
    async list(id) {
      const j = await call(id, 'backup_list', {});
      if (!Array.isArray(j.files)) throw bad(id, 'backup_list', 'gave an answer in the wrong shape');
      const out = [];
      for (const f of j.files) {
        if (!f || typeof f.name !== 'string' || !NAME.test(f.name) || !isSize(f.size)) continue;   // not one of ours
        out.push({ name: f.name, size: f.size, created: typeof f.created === 'string' ? f.created : null });
      }
      return out;
    },
    async remove(id, name) {
      if (!NAME.test(String(name))) throw new Error('That is not a backup name.');
      const j = await call(id, 'backup_delete', { name });
      if (typeof j.deleted !== 'boolean') throw bad(id, 'backup_delete', 'gave an answer in the wrong shape');
      return j.deleted;
    },
    async get(id, name, out) {
      if (!NAME.test(String(name))) throw new Error('That is not a backup name.');
      return sizeMd5(id, 'backup_get', await call(id, 'backup_get', { name, out }));
    },
  };
}

let single = null;
function getModulePlaces() { return single || (single = createModulePlaces({})); }

module.exports = { createModulePlaces, getModulePlaces };
