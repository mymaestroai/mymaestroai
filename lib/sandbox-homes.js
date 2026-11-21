'use strict';
// Agents' home folders in their boxes (Docker volumes), and whose they are.
//
// Docker volume names are global, like box names: another copy of your Maestro on the same computer (a test copy, a
// restore) carrying the same agents meets the same names. So a home this hub makes is a volume of its own name,
// <older name>-<12 hex of this install's id and data folder>, made with the labels agent-hub.install and agent-hub.home
// before any box mounts it, and mounted only while those labels are this install's.
//
// An older home (the volume named <older name>, made without labels) is ADOPTED only while rebuilding a box this hub has
// proved its own that mounts it: the box is stopped, the home is copied into the labelled volume by a sealed throwaway
// container, both are compared file by file, and only then does the box go and a new one come up on the labelled home.
// Each step is written to data/home-moves.json first, so a restart part way resumes or rolls back. A failed or slow copy
// falls back: the old box still goes (it may hold a folder the agent may no longer use, or older settings) and the new box
// is made on the older home, untouched; the move is tried again at most hourly, then daily after three failures in a row.
// The old home is kept 7 days after a move, then removed while the new one is in use. An older home with no box to prove whose it is (an orphan) is never adopted or removed: the agent gets a new home
// and Settings → Status names the old one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTAINER_HOME = '/home/agent';
const KEEP_OLD_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const RESERVE_KB = 5 * 1024 * 1024;   // free disk space a move leaves untouched (5 GB), beyond 1.2 x the home's size
// a size for people: "800 KB", "512 MB", "1.5 GB", "5 GB", "120 GB" (one decimal place below 10 GB, only where it isn't .0)
const sizeText = (kb) => {
  const k = Math.max(0, Math.round(Number(kb) || 0));
  if (k < 1024) return `${k} KB`;
  const m = Math.round(k / 1024);
  if (m < 1024) return `${m} MB`;
  const g = k / (1024 * 1024);
  return g < 10 ? `${Number(g.toFixed(1))} GB` : `${Math.round(g)} GB`;
};
const backoffMs = (count) => (count >= 3 ? 24 * HOUR : HOUR);   // after a failed move: hourly, daily after three in a row
const STOP_AFTER = 3;   // failures in a row for the same reason after which only an admin's "Move now" tries again
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const firstLine = (e) => String((e && (e.stderr || e.message)) || e || '').trim().split('\n')[0];
// Why a copy failed, as a plain sentence first; the tool's own words only when the cause isn't one of these, and last.
function plainCopyError(e) {
  const text = String((e && (e.stderr || e.message)) || e || '');
  let m;
  // causes for the whole copy first: tar may have printed a line about one file before them. Docker's own words are
  // looked for only outside tar's lines (a file in the home can be called .docker/config.json or docker.sock).
  const docker = text.split('\n').filter(l => !/^\s*tar: /.test(l)).join('\n');
  if (/permission denied while trying to connect to the Docker daemon/i.test(docker)) return "your Maestro isn't allowed to use Docker";
  if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test(docker)) return "Docker didn't answer";
  if (/No space left on device/i.test(text)) return 'the disk ran out of space during the copy';
  if (/No such image|Unable to find image|pull access denied/i.test(docker)) return 'the sandbox image is missing';
  if ((m = text.match(/tar: (.+?): Cannot open: Permission denied/))) return `a file in the home folder can't be read: ${m[1].replace(/^\.\//, '')}`;
  if ((m = text.match(/tar: (.+?): (?:Cannot stat|Cannot open): No such file or directory/))) return `a file in the home folder went away during the copy: ${m[1].replace(/^\.\//, '')}`;
  if ((m = text.match(/tar: (.+?): file changed as we read it/))) return `a file in the home folder changed during the copy: ${m[1].replace(/^\.\//, '')}`;
  const said = firstLine(e);
  return said ? `the copy failed; Docker said: ${said}` : 'the copy failed';
}

function createHomes({ run, identity, image, uid, gid, log, now, dataDir, legacyName, getSetting = () => undefined, boxOwner = async () => null, when = (ts) => String(ts || '') }) {
  const file = path.join(dataDir, 'home-moves.json');
  // { moves: { agent: { step, boxId, box, from, to, at } }, retired: [{ agent, volume, to, at }], orphans: [{ agent, volume, to }], failed: { agent: { why, sizeKB, at } } }
  function load() {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { moves: s.moves && typeof s.moves === 'object' ? s.moves : {}, retired: Array.isArray(s.retired) ? s.retired : [], orphans: Array.isArray(s.orphans) ? s.orphans : [], failed: s.failed && typeof s.failed === 'object' ? s.failed : {} };
    } catch (e) {
      if (e.code !== 'ENOENT') log(`could not read ${file} (${e.message}); starting from an empty record`);
      return { moves: {}, retired: [], orphans: [], failed: {} };
    }
  }
  // written whole to a temporary file, flushed and renamed: a crash leaves the old record or the new one, never half
  function save(s) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(s, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  const update = (fn) => { const s = load(); fn(s); save(s); return s; };
  // Every record carries this install's id and data-folder hash; only this install's own records are ever acted on or
  // shown. A copy or restore that carries data/ carries the records too, and they stay inert there.
  const stamp = () => { const me = identity(); return { install: me.install, home: me.home }; };
  const isMine = (e) => { if (!e || typeof e !== 'object') return false; let me; try { me = identity(); } catch { return false; } return e.install === me.install && e.home === me.home; };
  const mineOf = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => isMine(v)));
  const view = () => { const s = load(); return { moves: mineOf(s.moves), failed: mineOf(s.failed), retired: s.retired.filter(isMine), orphans: s.orphans.filter(isMine) }; };

  /** labelledName(agent): the volume name of this install's home for the agent. */
  function labelledName(agent) {
    const me = identity();
    return `${legacyName(agent)}-${sha256(`${me.install}\n${me.home}`).slice(0, 12)}`;
  }

  /** volumeOwner(name) -> { kind: 'absent'|'ours'|'foreign'|'unlabelled' }, or null when Docker didn't answer. */
  async function volumeOwner(name) {
    let r;
    try { r = await run(['volume', 'inspect', '--format', '{{json .Labels}}', name], { timeout: 15000 }); }
    catch (e) { return /no such volume/i.test(`${e && e.stderr || ''} ${e && e.message || ''}`) ? { kind: 'absent' } : null; }
    let labels;
    try { labels = JSON.parse(String(r.stdout || '').trim()); } catch { return null; }
    if (labels === null) return { kind: 'unlabelled' };
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return null;
    if (labels['agent-hub.install'] === undefined && labels['agent-hub.home'] === undefined) return { kind: 'unlabelled' };
    const me = identity();
    return labels['agent-hub.install'] === me.install && labels['agent-hub.home'] === me.home ? { kind: 'ours' } : { kind: 'foreign' };
  }
  const unchecked = (what) => Object.assign(new Error(`Your Maestro couldn't check ${what} (Docker didn't answer), so nothing new starts in this agent's box until it can.`), { code: 'EBOXUNCHECKED' });
  const foreignVolume = (name) => Object.assign(new Error(`The home folder ${name} isn't this Maestro's, so your Maestro doesn't use it, and this agent's shell and file tools are off until it's gone.`), { code: 'EVOLFOREIGN' });

  /** ensureHome(agent) -> the labelled home's name, made with this install's labels when missing. */
  async function ensureHome(agent) {
    const name = labelledName(agent);
    let o = await volumeOwner(name);
    if (!o) throw unchecked(`the home folder ${name}`);
    if (o.kind === 'absent') {
      const me = identity();
      await run(['volume', 'create', '--label', 'agent-hub=home', '--label', `agent-hub.agent=${agent.name}`, '--label', `agent-hub.install=${me.install}`, '--label', `agent-hub.home=${me.home}`, name], { timeout: 30000 });
      o = await volumeOwner(name);   // create says nothing when the name already existed: what matters is what is there now
      if (!o) throw unchecked(`the home folder ${name}`);
    }
    if (o.kind !== 'ours') throw foreignVolume(name);
    return name;
  }

  /** homeOfBox(id) -> the volume a box mounts as its home, '' when none, null when Docker didn't answer. */
  async function homeOfBox(id) {
    let r;
    try { r = await run(['inspect', '--type', 'container', '--format', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Destination}}={{.Name}}\n{{end}}{{end}}', id], { timeout: 10000 }); }
    catch { return null; }
    for (const l of String(r.stdout || '').split('\n')) { const i = l.indexOf('='); if (i > 0 && l.slice(0, i).trim() === CONTAINER_HOME) return l.slice(i + 1).trim(); }
    return '';
  }

  // A sealed throwaway container: no network, read-only root, no capabilities, the boxes' own user.
  const sealed = (name, mounts, script, secs) => ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${uid}:${gid}`, ...mounts, '--entrypoint', 'timeout', image, '-s', 'KILL', String(secs), 'bash', '-c', `set -o pipefail; ${script}`];
  // Every path with its type, size, mode and link target, then a sha256 of every file: one hash and a count.
  const MANIFEST = "cd \"$0\" && { find . -mindepth 1 -printf '%p\\t%y\\t%s\\t%m\\t%l\\n' | LC_ALL=C sort; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum; } | sha256sum | cut -d' ' -f1; find . -mindepth 1 | wc -l";
  async function inSealed(mounts, script, arg, timeoutMs) {
    const secs = Math.max(5, Math.ceil(timeoutMs / 1000));
    const name = `hub-home-move-${crypto.randomBytes(5).toString('hex')}`;
    const args = sealed(name, mounts, script, secs);
    if (arg !== undefined) args.push(arg);
    try { return await run(args, { timeout: timeoutMs + 30000, maxBuffer: 1024 * 1024 }); }
    catch (e) {
      // the docker client gave up: the container may still run; it is ours by its random name
      try { await run(['rm', '-f', name], { timeout: 30000 }); } catch {}
      throw e;
    }
  }
  async function sizeKB(vol) {
    try { const r = await inSealed(['-v', `${vol}:/v:ro`], 'du -sk /v | cut -f1', undefined, 120000); return Number(String(r.stdout).trim()) || null; } catch { return null; }
  }
  const moveTimeoutMs = () => { const m = Number(getSetting('sandboxHomeMoveMinutes')); return (Number.isFinite(m) && m > 0 ? m : 10) * 60 * 1000; };

  /**
   * copyAndCheck(from, to) -> { ok: true } | { ok: false, why }: everything in `from` copied into `to` (emptied first),
   * then both compared by manifest. `to` is mounted where the boxes mount their home, so a new volume gets the image's
   * home folder (its owner and mode) before anything is copied in.
   */
  async function copyAndCheck(from, to) {
    const limit = moveTimeoutMs(), started = now();
    try {
      // room for a second copy first: a move must never fill the disk the hub and everything else on it write to. The
      // apparent size: tar writes a sparse file at its full length.
      const sp = (await inSealed(['-v', `${from}:/from:ro`, '-v', `${to}:${CONTAINER_HOME}`], `du -sk --apparent-size /from | cut -f1; df -k --output=avail ${CONTAINER_HOME} | tail -1`, undefined, limit)).stdout;
      const [size, free] = String(sp || '').trim().split(/\s+/).map(Number);
      if (!Number.isFinite(size) || !Number.isFinite(free)) return { ok: false, kind: 'other', why: "your Maestro couldn't read the home folder's size or the free disk space" };
      const need = Math.ceil(size * 1.2) + RESERVE_KB;
      if (free < need) return { ok: false, kind: 'space', why: `there isn't enough free disk space for a second copy (the home folder holds ${sizeText(size)}, ${sizeText(free)} are free, ${sizeText(need)} are needed with a reserve)` };
      await inSealed(['-v', `${from}:/from:ro`, '-v', `${to}:${CONTAINER_HOME}`],
        // the entries inside the home, not the home folder itself (its owner and mode come from the image, as for any box)
        `find ${CONTAINER_HOME} -mindepth 1 -delete && cd /from && find . -mindepth 1 -maxdepth 1 -printf '%P\\0' | tar --null -T - -cf - | tar -xpf - -C ${CONTAINER_HOME}`, undefined, limit);
      const left = Math.max(60000, limit - (now() - started));
      const a = (await inSealed(['-v', `${from}:/m:ro`], MANIFEST, '/m', left)).stdout.trim();
      const b = (await inSealed(['-v', `${to}:/m:ro`], MANIFEST, '/m', left)).stdout.trim();
      if (!a || a !== b) return { ok: false, kind: 'mismatch', why: 'the copy is not the same as the original' };
      return { ok: true };
    } catch (e) {
      const killed = e && (e.killed || e.signal === 'SIGTERM' || e.code === 137 || e.code === 124);
      return { ok: false, kind: killed ? 'timeout' : 'copy', why: killed ? `the copy took longer than ${limit >= 60000 ? `${Math.round(limit / 60000)} minutes` : `${Math.round(limit / 1000)} seconds`}` : plainCopyError(e) };
    }
  }

  /** mayTry(agent): no failed move is waiting out its back-off. */
  const mayTry = (agent) => { const f = view().failed[agent.name]; return !f || (!f.stopped && now() >= Date.parse(f.nextAt || 0)); };
  /** backoffHome(agent) -> the older home a fallback box uses while a failed move waits out its back-off, else null. */
  const backoffHome = (agent) => { const f = view().failed[agent.name]; return f && (f.stopped || now() < Date.parse(f.nextAt || 0)) ? f.from : null; };
  /**
   * allowOnce(agent) -> the failed record as it was (or null): a stopped or waiting move may be tried once now (an
   * admin's "Move now"). restoreStop(agent, prev) puts it back when nothing was tried (the box was busy, or gone).
   */
  function allowOnce(agent) {
    const f = view().failed[agent.name] || null;
    if (f) update(s => { s.failed[agent.name] = { ...s.failed[agent.name], stopped: false, nextAt: new Date(now()).toISOString() }; });
    return f;
  }
  function restoreStop(agent, prev) {
    if (!prev) return;
    // only when no try happened since (each try adds one to the count)
    update(s => { const cur = s.failed[agent.name]; if (cur && isMine(cur) && cur.count === prev.count) s.failed[agent.name] = prev; });
  }
  /** failedFrom(agent) -> the older home of a failed move not yet done: the box stays on it until a move succeeds. */
  const failedFrom = (agent) => { const f = view().failed[agent.name]; return f ? f.from : null; };
  /**
   * adopt(agent, box, from) -> 'moved' or 'failed': the box (proved this hub's, { id, name }) is idle and STOPPED by the
   * caller; its older home `from` is copied into the labelled home. 'moved': the copy matches and the old box is gone
   * (the caller makes the new box, then calls finish). 'failed': nothing of `from` was changed and the partial copy is
   * emptied; the caller removes the old box and makes the new one on `from`; Status shows why, the home's size, how many
   * tries failed and when the next is due.
   */
  async function adopt(agent, box, from) {
    const to = await ensureHome(agent);
    update(s => { s.moves[agent.name] = { ...stamp(), step: 'copying', boxId: box.id, box: box.name, from, to, at: new Date(now()).toISOString() }; });
    log(`moving ${agent.name}'s home folder ${from} into ${to} (labelled with this install)`);
    const res = await copyAndCheck(from, to);
    if (!res.ok) {
      const kb = await sizeKB(from);
      try { await inSealed(['-v', `${to}:${CONTAINER_HOME}`], `find ${CONTAINER_HOME} -mindepth 1 -delete`, undefined, 10 * 60 * 1000); }
      catch (e) { log(`could not empty ${to} after the failed move: ${firstLine(e)}`); }
      const s2 = update(s => {
        delete s.moves[agent.name];
        const prev = isMine(s.failed[agent.name]) ? s.failed[agent.name] : null;
        const count = ((prev && prev.count) || 0) + 1;
        // failures in a row for the same reason; a different reason starts again at 1. Three: no more automatic tries.
        const same = prev && prev.kind === res.kind ? (prev.same || 1) + 1 : 1;
        s.failed[agent.name] = { ...stamp(), why: res.why, kind: res.kind || 'other', same, stopped: same >= STOP_AFTER, sizeKB: kb, count, at: new Date(now()).toISOString(), nextAt: new Date(now() + backoffMs(count)).toISOString(), from, to };
      });
      const f = s2.failed[agent.name];
      log(`could not move ${agent.name}'s home folder (${res.why}${kb ? `; ${kb} KB` : ''}; try ${f.count}); it keeps its older home, ${f.stopped ? `no more automatic tries (${f.same} in a row for the same reason)` : `next try after ${f.nextAt}`}`);
      return 'failed';
    }
    // a checked copy ends any earlier failure: from here the box goes onto the labelled home, also after a restart
    update(s => { s.moves[agent.name].step = 'verified'; delete s.failed[agent.name]; });
    await removeOldBox(agent.name, box.id);
    return 'moved';
  }
  async function removeOldBox(agentName, id) {
    try { await run(['rm', '-f', id], { timeout: 60000 }); }
    catch (e) { if (!/no such container/i.test(`${e && e.stderr || ''} ${e && e.message || ''}`)) throw e; }
    update(s => { if (s.moves[agentName]) s.moves[agentName].step = 'switched'; });
  }
  /** pending(agent) -> the recorded move, if one was under way. */
  const pending = (agent) => view().moves[agent.name] || null;
  /**
   * resume(agent) -> 'none' | 'rolled-back' | 'switched': a move a restart interrupted. Copying: forgotten (the old box
   * is still there, stopped, and the next turn starts over). Verified: the old box goes (the copy was checked).
   * Switched: nothing more here; the caller makes the box and calls finish.
   */
  async function resume(agent) {
    const m = pending(agent);
    if (!m) return 'none';
    if (m.step === 'copying') { update(s => { delete s.moves[agent.name]; }); log(`an interrupted move of ${agent.name}'s home folder is started over`); return 'rolled-back'; }
    if (m.step === 'verified') {
      // the recorded box is looked at again before it goes: only a box proved this hub's (or none at all)
      const k = await boxOwner(agent, m.boxId);
      if (!k) throw Object.assign(new Error(`Your Maestro couldn't check the box ${m.box} (Docker didn't answer), so nothing new starts in it until it can.`), { code: 'EBOXUNCHECKED' });
      if (k === 'foreign') { update(t => { delete t.moves[agent.name]; }); log(`an interrupted move of ${agent.name}'s home folder was dropped: ${m.box} isn't this Maestro's box`); return 'none'; }
      await removeOldBox(agent.name, m.boxId);
    }
    return 'switched';
  }
  /** finish(agent): the new box runs on the labelled home: the older home is kept 7 days. */
  function finish(agent) {
    const m = pending(agent);
    if (!m || m.step !== 'switched') return;
    update(s => {
      delete s.moves[agent.name];
      delete s.failed[agent.name];
      s.retired = s.retired.filter(r => r.volume !== m.from);
      s.retired.push({ ...stamp(), agent: agent.name, volume: m.from, to: m.to, at: new Date(now()).toISOString() });
    });
    log(`${agent.name}'s home folder now is ${m.to}; the older ${m.from} is kept 7 days`);
  }
  /** noteOrphan(agent, legacy): an older home nothing proves is this hub's: left alone, named on Status. */
  async function noteOrphan(agent) {
    const legacy = legacyName(agent);
    const o = await volumeOwner(legacy);
    if (!o || o.kind !== 'unlabelled') return;
    const to = labelledName(agent);
    update(s => { s.orphans = s.orphans.filter(x => x.volume !== legacy); s.orphans.push({ ...stamp(), agent: agent.name, volume: legacy, to }); });
    log(`left ${legacy} as it is: no box proves it is ${agent.name}'s home folder in this Maestro; ${agent.name} gets a new home folder ${to}`);
  }

  let lastPrune = 0;
  /** prune(): older homes kept 7 days go while their new home is there; orphans that are gone leave Status. */
  async function prune({ force = false } = {}) {
    if (!force && now() - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = now();
    const s = view();
    const gone = new Set();   // volumes no longer to list
    for (const r of s.retired) {
      if (now() - Date.parse(r.at) < KEEP_OLD_MS) continue;
      const inUse = await volumeOwner(r.to);
      if (!inUse || inUse.kind !== 'ours') continue;   // the new home isn't there: the older one stays
      const act = await removeKept(r);
      if (act !== 'kept') gone.add(r.volume);
    }
    for (const x of s.orphans) { const o = await volumeOwner(x.volume); if (o && o.kind === 'absent') gone.add(x.volume); }
    if (gone.size) update(t => { t.retired = t.retired.filter(r => !(isMine(r) && gone.has(r.volume))); t.orphans = t.orphans.filter(x => !(isMine(x) && gone.has(x.volume))); });
  }
  // A kept older home is removed only while it is still what was kept: a volume without labels. Gone: 'gone'. Labelled
  // since (another copy made a volume of that name): left as it is and no longer listed, 'dropped'. Else 'kept'.
  async function removeKept(r) {
    const o = await volumeOwner(r.volume);
    if (!o) return 'kept';
    if (o.kind === 'absent') return 'gone';
    if (o.kind !== 'unlabelled') { log(`left ${r.volume} as it is: it now carries labels, so it isn't the older home kept for ${r.agent}`); return 'dropped'; }
    try { await run(['volume', 'rm', r.volume], { timeout: 60000 }); log(`removed ${r.agent}'s older home folder ${r.volume}`); return 'gone'; }
    catch (e) {
      if (/no such volume/i.test(`${e && e.stderr || ''} ${e && e.message || ''}`)) return 'gone';
      log(`could not remove ${r.volume}: ${firstLine(e)}`); return 'kept';
    }
  }
  /** dropRetired(agent): an agent's home is removed (Reset with home, retire): its kept older homes go too. */
  async function dropRetired(agent) {
    for (const r of view().retired.filter(x => x.agent === agent.name)) {
      if ((await removeKept(r)) === 'kept') continue;
      update(t => { t.retired = t.retired.filter(x => !(isMine(x) && x.volume === r.volume)); });
    }
  }

  function readinessItems() {
    const s = view(), items = [];
    for (const [a, f] of Object.entries(s.failed)) {
      const times = `${f.count || 1} time${(f.count || 1) === 1 ? '' : 's'}`;
      const fixFor = {
        space: 'Free disk space where Docker keeps its volumes, or clear what the home folder doesn\'t need.',
        timeout: 'Clear what the home folder doesn\'t need, or raise the time limit (setting sandboxHomeMoveMinutes).',
        copy: 'A file in the home folder can\'t be read by the agent\'s box user; remove or fix that file.',
        mismatch: 'Something changed the home folder during the copy; try again when the agent is idle.',
      }[f.kind] || 'Check that Docker works and has room for a second copy of the home folder.';
      const base = `Your Maestro is moving each agent's home folder into one labelled as this Maestro's. For ${a} it has failed ${times}, last on ${when(f.at)}: ${f.why}${f.sizeKB ? ` (the home folder holds ${sizeText(f.sizeKB)})` : ''}. ${a} keeps working with its older home folder, unchanged`;
      items.push(f.stopped ? {
        id: 'sandbox-home-move-' + a, level: 'warn', title: `${a}'s home folder isn't being moved any more`,
        detail: `${base}. It failed ${f.same} times in a row for the same reason, so your Maestro stopped trying on its own.`,
        fix: `${fixFor} Then press Move now: it tries once, when ${a} is idle.`,
        action: { label: 'Move now', api: `/api/sandbox/agents/${encodeURIComponent(a)}/move-home`, method: 'POST' },
      } : {
        id: 'sandbox-home-move-' + a, level: 'warn', title: `${a}'s home folder couldn't be moved yet`,
        detail: `${base}; the next try is at its first idle turn after ${when(f.nextAt)}.`,
        fix: fixFor,
      });
    }
    for (const r of s.retired) {
      const until = new Date(Date.parse(r.at) + KEEP_OLD_MS);
      items.push({
        id: 'sandbox-home-kept-' + r.volume, level: 'info', title: `${r.agent}'s older home folder is kept until ${when(until.getTime())}`,
        detail: `${r.agent}'s home folder moved into ${r.to} on ${when(r.at)}. The older copy ${r.volume} is kept until ${when(until.getTime())}, then removed.`,
        fix: 'Nothing to do. To undo the move before then, ask your lead agent.',
      });
    }
    for (const x of s.orphans) items.push({
      id: 'sandbox-home-orphan-' + x.volume, level: 'warn', title: `An older home folder of ${x.agent} was left as it is`,
      detail: `The home folder ${x.volume} has no box that shows it belongs to this Maestro, so your Maestro didn't use or remove it; ${x.agent} got a new home folder ${x.to}.`,
      fix: `If ${x.volume} is this Maestro's and nothing in it is needed, remove it with "docker volume rm ${x.volume}". If another copy of your Maestro uses it, leave it.`,
    });
    return items;
  }

  const failedOf = (agent) => view().failed[agent.name] || null;
  /** dropFailed(agent): a failed move with nothing left to move ends (its older home is gone). */
  const dropFailed = (agent) => update(t => { if (isMine(t.failed[agent.name])) delete t.failed[agent.name]; });
  return { labelledName, volumeOwner, ensureHome, homeOfBox, adopt, mayTry, backoffHome, failedFrom, failedOf, dropFailed, allowOnce, restoreStop, resume, pending, finish, noteOrphan, prune, dropRetired, readinessItems, copyAndCheck, file };
}

module.exports = { createHomes, KEEP_OLD_MS, sizeText };
