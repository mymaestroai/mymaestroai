'use strict';
/**
 * A deleted agent's things, kept together: data/archived-agents/<name>-<when>/ (a "bundle").
 *
 * Deleting an agent used to take it off the list only. Its folder, chat, sessions, memory, notes, conversation
 * archive, scheduled tasks and sandbox box stayed under its name, so the name stayed taken until someone cleared them
 * by hand. Now deleting moves all of it into one bundle and the name is free at once: a new agent of that name starts
 * clean. Nothing is thrown away. Every step can run again: a bundle that isn't finished keeps ".partial" in its name,
 * keeps the name taken, and is finished at the next start, or when someone wants the name.
 *
 * In a bundle (each only when the agent had it):
 *   manifest.json         who it was (its list entry), when and why it was archived, each step's result
 *   workspace/            workspaces/<name>: identity files, Records, its own files
 *   files/                its own Files folder (share/<name>); a team's, a member's or the shared folder stays put
 *   chat.jsonl            data/conversations/<name>.jsonl (chat-old.json: the older format)
 *   notes/                data/sessions/<name>
 *   context-refresh.json  what it was last told about its Records
 *   scheduled-tasks.json  the tasks that would have woken it
 *   sessions.json         its Claude and Codex session ids
 *   memory.json           its long-term memory, session notes and distillations
 *   archive.db            its conversation archive (searchable with the same SQLite tools)
 *   box-home.tar          its sandbox box's home folder; the box itself is removed
 */
const fs = require('fs');
const path = require('path');

const PARTIAL = '.partial';
const MANIFEST = 'manifest.json';
// The box goes first, so nothing running in it can write into the folders while they move.
const STEPS = ['box', 'workspace', 'files', 'chat', 'notes', 'contextRefresh', 'tasks', 'sessions', 'memory', 'archive'];
const STEP_LABEL = { box: 'sandbox box', workspace: 'folder', files: 'Files folder', chat: 'chat history', notes: 'notes folder', contextRefresh: 'context notes', tasks: 'scheduled tasks', sessions: 'sessions', memory: 'memory', archive: 'conversation archive' };

const has = (p) => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const iso = (ms) => new Date(ms).toISOString();
// A folder name for any agent name: plain names as they are, anything else as hex (never a path or a dot name).
const dirNameOf = (name) => (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) ? name : `~${Buffer.from(String(name), 'utf8').toString('hex').slice(0, 120)}`);

function readJson(file) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return JSON.parse(raw);
}
function writeJson(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
// The next name not taken: chat.jsonl, chat-2.jsonl, ... A file or folder already in a bundle is never replaced.
function freeName(p) {
  if (!has(p)) return p;
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) { const q = `${base}-${i}${ext}`; if (!has(q)) return q; }
}
/** Move src into the bundle as dst (renamed, or copied then removed across disks). -> false when there was nothing. */
function moveAside(src, dst) {
  if (!has(src)) return false;
  const target = freeName(dst);
  try { fs.renameSync(src, target); return true; }
  catch (e) { if (e.code !== 'EXDEV') throw e; }
  // Another disk: a whole copy under a temporary name first, so a copy cut short never passes for the real thing.
  const tmp = `${target}.copying`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(src, tmp, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
  fs.renameSync(tmp, target);
  fs.rmSync(src, { recursive: true, force: true });
  return true;
}

function createAgentArchive({
  dataDir,                                  // the install's data/ folder
  dir = path.join(dataDir, 'archived-agents'),
  workspaceFor,                             // name -> workspaces/<name>
  filesFolderFor = () => null,              // (name, entry) -> the agent's own Files folder, or null
  sessionMapFiles = [],                     // [[file, label]]: name -> session id maps
  memory = () => null,                      // () => { exportAgentMemory(name), deleteAgentMemoryRows(name, ids) }
  transcript = () => null,                  // () => { moveOut(name, dest) }
  scheduler = () => null,                   // () => { tasksOf(name), action(id, 'owner', 'delete') }, or null when not loaded
  scheduledTasksFile = null,                // its file, read when the scheduler isn't loaded
  sandbox = () => null,                     // () => { retire(agent, intoDir, { boxed }) }
  isBoxed = () => false,                    // (entry) -> whether the agent runs in a box
  boxNameOf = null,                         // (entry) -> the name of its box (lib/sandbox containerNameFor)
  forget = () => {},                        // (name): the running hub drops what it keeps in memory for that name
  now = Date.now,
  log = (...a) => console.log('[agents]', ...a),
} = {}) {
  const locks = new Map();   // name -> the run in progress: one at a time per name
  const conv = (name) => path.join(dataDir, 'conversations', `${name}.jsonl`);

  // the box an entry runs in; two entries with the same box are the same agent's (or a copy put back by a restore)
  const sameBox = (entry, live) => !!(boxNameOf && live && boxNameOf(entry) === boxNameOf(live));
  const step = {
    async box(b, m, live) {
      if (live && (!boxNameOf || sameBox({ ...(m.entry || {}), name: m.name }, live))) throw new Error(`the agent now called ${m.name} uses this box`);
      const sb = sandbox();
      if (!sb) return 'no sandbox here';
      const r = await sb.retire({ ...(m.entry || {}), name: m.name }, b, { boxed: m.entry ? isBoxed(m.entry) : null, keepHome: !!m.keepHome });
      return r.result;
    },
    workspace: (b, m) => (moveAside(workspaceFor(m.name), path.join(b, 'workspace')) ? 'moved' : 'none'),
    files(b, m) {
      const f = filesFolderFor(m.name, m.entry);
      return f && moveAside(f, path.join(b, 'files')) ? 'moved' : 'none';
    },
    chat(b, m) {
      const a = moveAside(conv(m.name), path.join(b, 'chat.jsonl'));
      const old = moveAside(path.join(dataDir, 'conversations', `${m.name}.json`), path.join(b, 'chat-old.json'));
      return a || old ? 'moved' : 'none';
    },
    notes: (b, m) => (moveAside(path.join(dataDir, 'sessions', m.name), path.join(b, 'notes')) ? 'moved' : 'none'),
    contextRefresh: (b, m) => (moveAside(path.join(dataDir, 'context-refresh', `${String(m.name).replace(/[^a-z0-9_-]/gi, '_')}.json`), path.join(b, 'context-refresh.json')) ? 'moved' : 'none'),
    tasks(b, m) {
      const st = scheduler();
      if (!st) {
        // The scheduler isn't loaded (a tool outside the hub): a task in its file for this name waits for the hub.
        const doc = scheduledTasksFile ? readJson(scheduledTasksFile) : null;
        if (doc && (doc.tasks || []).some(t => t && t.agent === m.name)) throw new Error('the scheduler is not running here');
        return 'none';
      }
      const mine = st.tasksOf(m.name);
      if (!mine.length) return 'none';
      const file = path.join(b, 'scheduled-tasks.json');
      const kept = readJson(file) || [];
      const ids = new Set(kept.map(t => t.id));
      writeJson(file, kept.concat(mine.filter(t => !ids.has(t.id))));   // kept before they leave the list
      for (const t of mine) st.action(t.id, 'owner', 'delete');
      return `moved ${mine.length}`;
    },
    sessions(b, m) {
      const file = path.join(b, 'sessions.json');
      const kept = readJson(file) || {};
      const moved = [];
      for (const [mapFile, label] of sessionMapFiles) {
        let map;
        try { map = readJson(mapFile); } catch { throw new Error(`${path.basename(mapFile)} can't be read`); }   // never rewritten on a guess
        if (!map || typeof map !== 'object' || !Object.prototype.hasOwnProperty.call(map, m.name)) continue;
        kept[label] = map[m.name];
        writeJson(file, kept);
        delete map[m.name];
        writeJson(mapFile, map, fs.statSync(mapFile).mode & 0o777);
        moved.push(label);
      }
      return moved.length ? `moved: ${moved.join(', ')}` : 'none';
    },
    memory(b, m) {
      const mem = memory();
      if (!mem) return 'none';
      const rows = mem.exportAgentMemory(m.name);
      const n = Object.values(rows).reduce((s, list) => s + list.length, 0);
      if (!n) return 'none';
      const file = path.join(b, 'memory.json');
      const kept = readJson(file) || {};
      for (const [table, list] of Object.entries(rows)) {
        const ids = new Set((kept[table] || []).map(r => r.id));
        kept[table] = (kept[table] || []).concat(list.filter(r => !ids.has(r.id)));
      }
      writeJson(file, kept);
      // only the rows just kept leave: anything written meanwhile stays, and keeps the name taken until the next run
      mem.deleteAgentMemoryRows(m.name, Object.fromEntries(Object.entries(rows).map(([t, list]) => [t, list.map(r => r.id)])));
      return `moved ${n} rows`;
    },
    archive(b, m) {
      const tr = transcript();
      if (!tr) return 'none';
      const r = tr.moveOut(m.name, path.join(b, 'archive.db'));
      return r.moved ? `moved${r.rows != null ? ` ${r.rows} rows` : ''}` : 'none';
    },
  };

  function bundles() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const out = [];
    for (const n of names) {
      if (n.startsWith('.')) continue;   // a bundle still being made (begin)
      const b = path.join(dir, n);
      let m = null;
      try { m = readJson(path.join(b, MANIFEST)); } catch {}
      if (m && typeof m.name !== 'string') m = null;
      out.push({ dir: b, folder: n, partial: n.endsWith(PARTIAL), manifest: m });   // manifest null: unreadable (an admin looks)
    }
    return out;
  }
  // An unfinished bundle holds its name while anything but the box is still to move: an agent made since boxes carry
  // their own id never starts in an earlier agent's box (lib/sandbox containerName), so a box left for later doesn't
  // stand in a new agent's way. One whose manifest can't be read holds the name its folder has.
  const folderOf = (name) => new RegExp(`^${dirNameOf(name).replace(/[^a-z0-9~]/gi, (c) => `\\${c}`)}-\\d{8}T\\d{6}Z(-\\d+)?\\${PARTIAL}$`);
  const holdsName = (m) => STEPS.some(s => s !== 'box' && !(m.steps && m.steps[s] && m.steps[s].done));
  const pendingFor = (name) => bundles().filter(x => x.partial && (x.manifest ? x.manifest.name === name && holdsName(x.manifest) : folderOf(name).test(x.folder)));

  /** begin({ name, entry, reason }) -> bundle folder: made (with its manifest) before anything leaves its place. */
  function begin({ name, entry = null, reason = 'deleted', keepHome = false }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const when = iso(now());
    const stamp = when.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');   // 20261105T163000Z
    let b = path.join(dir, `${dirNameOf(name)}-${stamp}${PARTIAL}`);
    for (let i = 2; has(b); i++) b = path.join(dir, `${dirNameOf(name)}-${stamp}-${i}${PARTIAL}`);
    // made under a hidden name with its manifest, then renamed: a bundle never exists without one
    const tmp = path.join(dir, `.${path.basename(b)}.${process.pid}.new`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { mode: 0o700 });
    writeJson(path.join(tmp, MANIFEST), { version: 1, name, reason, archivedAt: when, entry, ...(keepHome ? { keepHome: true } : {}), steps: {}, finishedAt: null });
    fs.renameSync(tmp, b);
    return b;
  }

  /**
   * run(bundle, { only }) -> { dir, finished, unfinished: [{ step, label, error }] }: the steps not done yet, in order
   * (only: just those, e.g. the box of a name in use again).
   */
  async function run(b, { only = null, live = null } = {}) {
    const m = readJson(path.join(b, MANIFEST));
    const prior = locks.get(m.name) || Promise.resolve();
    const mine = prior.catch(() => {}).then(() => runNow(b, only, live));
    locks.set(m.name, mine);
    try { return await mine; } finally { if (locks.get(m.name) === mine) locks.delete(m.name); }
  }
  async function runNow(b, only, live) {
    if (!has(b)) return { dir: b, finished: true, unfinished: [] };   // another run finished it meanwhile
    const m = readJson(path.join(b, MANIFEST));
    const unfinished = [];
    for (const s of STEPS) {
      if (m.steps[s] && m.steps[s].done) continue;
      if (only && !only.includes(s)) { unfinished.push({ step: s, label: STEP_LABEL[s], error: 'not run' }); continue; }
      try { m.steps[s] = { done: true, at: iso(now()), result: await step[s](b, m, live) }; }
      catch (e) {
        m.steps[s] = { done: false, at: iso(now()), error: String(e && e.message || e) };
        unfinished.push({ step: s, label: STEP_LABEL[s], error: m.steps[s].error });
      }
      writeJson(path.join(b, MANIFEST), m);
    }
    if (!only) { try { forget(m.name); } catch {} }
    if (unfinished.length) {
      log(`${m.name}: kept in ${path.basename(b)}, but not yet: ${unfinished.map(u => `${u.label} (${u.error})`).join('; ')}. The hub tries again at its next start.`);
      return { dir: b, finished: false, unfinished };
    }
    m.finishedAt = iso(now());
    writeJson(path.join(b, MANIFEST), m);
    const done = freeName(b.slice(0, -PARTIAL.length));
    fs.renameSync(b, done);
    log(`${m.name}: everything it left is in ${path.relative(path.dirname(dataDir), done)}`);
    return { dir: done, finished: true, unfinished: [] };
  }

  /**
   * finishPending({ inUse }) -> results: finishes bundles a run left unfinished (the hub calls it at start). inUse(name)
   * -> the agent listed under that name now, or null; asked again for each bundle, just before it runs. For a name in
   * use again only the earlier agent's box is done, and only when it isn't the listed agent's own box: every other step
   * would take what now belongs to the agent listed. A bundle with nothing moved whose agent is still listed with the
   * same box is a delete that stopped before the agent left the list: it is undone.
   */
  async function finishPending({ inUse = () => null, guard = (name, fn) => fn() } = {}) {
    const out = [];
    for (const x of bundles()) {
      if (!x.partial) continue;
      const m = x.manifest;
      if (!m) { log(`${x.folder}: unfinished, and its manifest can't be read; it stays as it is`); continue; }
      await guard(m.name, () => finishOne(x, m, inUse, out));
    }
    return out;
  }
  async function finishOne(x, m, inUse, out) {
    if (!has(x.dir)) return;   // finished meanwhile (a create of that name ran it)
    {
      let live;
      try { live = inUse(m.name) || null; } catch (e) { log(`${x.folder}: waits (${e.message})`); return; }
      try {
        if (!live) { out.push(await run(x.dir)); return; }
        const own = !boxNameOf || sameBox({ ...(m.entry || {}), name: m.name }, live);
        let inside = [];
        try { inside = fs.readdirSync(x.dir); } catch {}
        if (own && !Object.keys(m.steps || {}).length && inside.length === 1 && inside[0] === MANIFEST) {
          fs.rmSync(x.dir, { recursive: true, force: true });
          log(`${m.name}: a delete that stopped before the agent left the list was undone (nothing had moved)`);
          return;
        }
        if (own) { log(`${m.name}: ${x.folder} is unfinished, and the agent listed under that name has the same box; it stays as it is`); return; }
        out.push(await run(x.dir, { only: ['box'], live }));
      } catch (e) { log(`${m.name}: could not finish ${x.folder}: ${e.message}`); }
    }
  }

  return { begin, run, bundles, pendingFor, finishPending, STEPS, STEP_LABEL, dir };
}

module.exports = { createAgentArchive, moveAside, freeName, STEPS, STEP_LABEL };
