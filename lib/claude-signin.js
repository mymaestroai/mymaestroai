'use strict';
// The Claude sign-in engine: signs the Claude client in on the computer that runs the hub, with the client's own
// `auth login --claudeai`, so the sign-in lands where the agents' turns read it. Used by the page (later) and by
// `mymaestro connect claude`. One attempt at a time. The pasted code goes to the client's standard input and nowhere
// else: it is not stored, logged or put in state. The client's output is kept in memory only (capped) and never logged.
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { startGroup } = require('./claude-signin-group');
const { guardProgram, guardInstaller } = require('./claude-signin-guard');
const { spawn: realSpawn } = require('node:child_process');

const WORDS = {
  signedOut: 'Claude is signed out on the computer that runs your Maestro.',
  openLink: 'Open this link on any computer or phone, sign in with the Claude account that has your plan, and approve.',
  pasteCode: 'The page then shows a code. Copy all of it and paste it here.',
  checking: 'Checking that Claude answers…',
  done: 'Signed in. Claude answers again. Send your message again.',
  failed: {
    code: "That code didn't work: it may have expired or been cut short. Start again and paste the whole code.",
    network: "This computer couldn't reach Claude. Check its internet connection, then try again.",
    account: "You're signed in, but this Claude account can't run Claude Code: it may have no Claude plan, or it's a different account. Sign in with the account that has your plan.",
    limit: 'Signed in, but this Claude plan has reached its usage limit. It works again when the limit resets.',
    timeout: 'The sign-in took too long and was stopped. Start again.',
    missing: "Claude Code isn't on this computer and couldn't be installed. On that computer run: curl -fsSL https://claude.ai/install.sh | bash",
    busy: 'A sign-in is already in progress.',
    error: "The sign-in didn't finish. Start again; if it keeps failing, run `mymaestro doctor` on that computer.",
  },
};
const INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash';
// What the engine runs: the same command, but a failed download is a failed install (not the exit code of the last `bash`).
const INSTALL_SCRIPT = `set -o pipefail; ${INSTALL_COMMAND}`;
const CODE_WAIT_MS = 60 * 1000;   // after a code was handed to the client: no change in this long -> failed 'error'
const CODE_REJECTED_RE = /invalid code|code (has )?expired/i;
const OUTPUT_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function isExecutableFile(fsx, p) {
  try {
    if (!fsx.statSync(p).isFile()) return false;
    fsx.accessSync(p, fsx.constants ? fsx.constants.X_OK : fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** The Claude client the agents' turns use: {bin, source} or null. */
function findClient({ env = process.env, fs: fsx = fs, platform = process.platform, arch = process.arch, home = null, resolveCli = null, sdkDir = null } = {}) {
  const ok = (p) => isExecutableFile(fsx, p);
  if (env && env.CLAUDE_CLI_PATH && ok(env.CLAUDE_CLI_PATH)) return { bin: env.CLAUDE_CLI_PATH, source: 'CLAUDE_CLI_PATH' };
  try {
    const rc = resolveCli || (() => require('./sdk-loader').resolveCli());
    const c = rc();
    if (c && c.bin && ok(c.bin)) return { bin: c.bin, source: c.source || 'sdk-loader' };
  } catch { /* no loader result */ }
  // The SDK's bundled native client, next to the SDK package.
  try {
    let dir = sdkDir;
    if (!dir) { try { dir = require('./sdk-loader').resolveSdk().dir; } catch { dir = null; } }
    if (dir) {
      const plat = platform === 'win32' ? 'win32' : platform;
      const names = platform === 'linux'
        ? [`claude-agent-sdk-linux-${arch}`, `claude-agent-sdk-linux-${arch}-musl`]
        : [`claude-agent-sdk-${plat}-${arch}`];
      for (const n of names) {
        for (const base of [path.join(dir, '..'), path.join(dir, 'node_modules', '@anthropic-ai')]) {
          const p = path.join(base, n, 'claude');
          if (ok(p)) return { bin: p, source: 'sdk-bundled' };
        }
      }
    }
  } catch { /* none */ }
  for (const d of String((env && env.PATH) || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, 'claude');
    if (ok(p)) return { bin: p, source: 'PATH' };
  }
  const h = home || (env && env.HOME) || os.homedir();
  for (const p of [path.join(h, '.local', 'bin', 'claude'), path.join(h, '.claude', 'local', 'claude')]) {
    if (ok(p)) return { bin: p, source: 'home' };
  }
  return null;
}

/** Same HOME and CLAUDE_CONFIG_DIR as agent turns (no API key; no sign-in token from the private store folded in by us). */
function clientEnv(base = process.env) { return require('./billing').claudeClientEnv(base); }

/** The CLAUDE_CONFIG_DIR value of an install's .env file, or null. Reads that one key only; no other value is kept or returned. */
function configDirFromEnvFile(file, { fs: fsx = fs } = {}) {
  let text;
  try { text = fsx.readFileSync(file, 'utf8'); } catch { return null; }
  let found = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?CLAUDE_CONFIG_DIR\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    const q = /^(["'])(.*?)\1/.exec(v);
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, '').trim();
    found = v || null;   // the last assignment wins
  }
  return found;
}

/** `bin auth status --json` -> { loggedIn: true|false|null, method }. Never logs output. */
function authStatus({
  bin, env = process.env, timeoutMs = 20000, signal,
  spawn, setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  if (!spawn) spawn = realSpawn;
  guardProgram(bin);   // every spawn function, injected or not: never a program the guard refuses
  const unknown = { loggedIn: null, method: null };
  if (signal?.aborted) return Promise.resolve(unknown);
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, ['auth', 'status', '--json'], {
        env, stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch { resolve(unknown); return; }

    let out = '', stopped = false, failed = false, exited = false;
    let finished = false, tail = null;
    function finish(code) {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      if (tail !== null) clearTimer(tail);
      signal?.removeEventListener('abort', stop);
      child.stdout?.destroy?.();
      if (stopped || failed) { resolve(unknown); return; }
      try {
        const j = JSON.parse(out);
        if (typeof j?.loggedIn === 'boolean') {
          resolve({ loggedIn: j.loggedIn, method: j.authMethod || null });
          return;
        }
      } catch { /* fall back to exit status */ }
      resolve(code === 1 ? { loggedIn: false, method: null } : unknown);
    }
    function finishSoon(code) {
      if (!finished && tail === null) tail = setTimer(() => finish(code), 500);
    }
    function stop() {
      if (finished || stopped) return;
      stopped = true;
      if (!exited) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      finishSoon(null);
    }
    const timer = setTimer(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', chunk => {
      if (out.length < OUTPUT_CAP) out += String(chunk).slice(0, OUTPUT_CAP - out.length);
    });
    child.on('error', () => { failed = true; finishSoon(null); });
    child.once('exit', code => { exited = true; finishSoon(code); });
    child.once('close', finish);
    if (signal?.aborted) stop();
  });
}

// Bound abandonment of an already-aborted probe. Keep a rejection handler
// attached if the SDK settles after the slot has been released.
function abortBound(operation, signal, setTimer, clearTimer, graceMs) {
  return new Promise((resolve, reject) => {
    let timer = null, done = false;
    function finish(fn, value) {
      if (done) return;
      done = true;
      if (timer !== null) clearTimer(timer);
      signal.removeEventListener('abort', abort);
      fn(value);
    }
    function abort() {
      timer = setTimer(() => finish(reject, new Error('Sign-in check cancelled')), graceMs);
    }
    if (signal.aborted) { reject(new Error('Sign-in check cancelled')); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      Promise.resolve(operation()).then(v => finish(resolve, v), e => finish(reject, e));
    } catch (err) { finish(reject, err); }
  });
}

function installClient({ spawn, platform = process.platform, timeoutMs = 300000,
  setTimer = setTimeout, clearTimer = clearTimeout, onChild = null, kill } = {}) {
  guardInstaller(spawn);
  if (platform !== 'linux' && platform !== 'darwin') return Promise.resolve(false);
  let job;
  try {
    job = startGroup('bash', ['-c', INSTALL_SCRIPT], {
      spawn, kill, setTimer, installer: true, stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch { return Promise.resolve(false); }
  return new Promise(resolve => {
    let timedOut = false;
    const timer = setTimer(() => { timedOut = true; job.stop(); }, timeoutMs);
    job.once('result', code => {
      clearTimer(timer);
      resolve(!timedOut && code === 0);
    });
    if (onChild) onChild(job);
  });
}

function reasonFromOutput(text) {
  const t = String(text || '');
  if (/invalid code|code.*(expired|invalid)/i.test(t)) return 'code';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|fetch failed|could not connect/i.test(t)) return 'network';
  return 'error';
}

/** The default verify: a check turn through the real client (it would reach the network). Refused under node --test. */
function defaultVerify({ signal } = {}) {
  guardProgram();
  return require('./welcome').getWelcome().checkClaude({
    timeoutMs: 90000, signal, probeOnly: true
  });
}

/** An external client the hub already resolved (the SDK loader's) that exists on disk, or null. */
function existingClient({ resolveCli = null } = {}) {
  try {
    const c = (resolveCli || (() => require('./sdk-loader').resolveCli()))();
    return c && c.bin && isExecutableFile(fs, c.bin) ? c : null;   // the same "usable client" rule as findClient
  } catch { return null; }
}

/** A checkClaude() answer -> a failure reason. */
function reasonFromVerify(r) {
  const s = r && r.state;
  if (s === 'signed-out') return 'account';
  if (s === 'limit') return 'limit';
  if (s === 'network') return 'network';
  return 'error';
}

function extractLink(text) {
  const clean = (u) => u.replace(/[.,;:!?)\]}'">]+$/, '');
  // Only a URL that is followed by whitespace: a half-arrived chunk is not a link yet.
  const m = /visit:\s*(https?:\/\/\S+)\s/i.exec(text);
  if (m) return clean(m[1]);
  const all = text.match(/https:\/\/\S+(?=\s)/g) || [];
  const o = all.find(u => /oauth/i.test(u));
  return o ? clean(o) : null;
}

function createSignIn(deps = {}) {
  const spawn = deps.spawn;   // undefined = the real spawn, behind the node --test guard (startGroup / authStatus / installClient)
  const getEnv = deps.env || (() => clientEnv(process.env));
  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const platform = deps.platform || process.platform;
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const find = deps.findClient || (() => findClient({ env: process.env }));
  const install = deps.installClient || ((o) => installClient({ platform, spawn, setTimer, clearTimer, onChild: o && o.onChild, kill: deps.kill }));
  const status = deps.authStatus || (opts =>
    authStatus({ ...opts, spawn, setTimer, clearTimer }));
  const verify = deps.verify || defaultVerify;
  // A client the hub already uses (the SDK loader's, or the SDK's own) means nothing is installed. With an injected findClient
  // the loader is not asked (tests), unless existingClient is injected too.
  // (A file that is there but not executable is not a client in any path: findClient and existingClient use the same check.)
  const existing = deps.existingClient || (deps.findClient ? () => null : existingClient);
  const resetCli = deps.resetCli || (() => require('./sdk-loader').resetCli());
  const killProc = deps.kill || ((pid, sig) => process.kill(pid, sig));   // process.kill(-pid, sig) ends a whole process group
  const codeWaitMs = deps.codeWaitMs || CODE_WAIT_MS;

  let st = { state: 'idle', id: null, link: null, reason: null, message: null, startedAt: null };
  let run = null;   // the live attempt: { id, kids, buf, timer, ... }
  const ending = new Set();   // attempts that ended but whose children have not all exited yet: they keep the slot

  const ACTIVE = ['starting', 'installing', 'link', 'checking'];
  const busy = () => ACTIVE.includes(st.state) || ending.size > 0;
  const liveKids = (r) => r.kids.filter(k => !k.exited);

  function track(r, job) {
    const rec = { job, exited: false };
    r.kids.push(rec);
    job.drained.then(() => {
      rec.exited = true;
      release(r);
    });
    if (r.ended) job.stop();
  }
  function release(r) {
    if (!r.ended || r.checkPending || liveKids(r).length) return;
    ending.delete(r);
    if (r.exitHook) { process.removeListener('exit', r.exitHook); r.exitHook = null; }
  }
  function endKids(r) {
    for (const k of liveKids(r)) k.job.stop();
  }
  /** End an attempt: its timers stop and every child it owns is ended by process group. */
  function cleanup(r) {
    if (!r) return;
    if (r.timer) { clearTimer(r.timer); r.timer = null; }
    if (r.codeTimer) { clearTimer(r.codeTimer); r.codeTimer = null; }
    r.ended = true;
    if (r.checkPending || liveKids(r).length) ending.add(r);
    r.abort.abort();
    endKids(r);
    release(r);
    if (run === r) run = null;
  }
  function fail(r, reason) {
    if (r !== run) return;
    cleanup(r);
    st = { state: 'failed', id: r.id, link: null, reason, message: WORDS.failed[reason] || WORDS.failed.error, startedAt: st.startedAt };
  }
  function current(r) { return r === run; }

  async function checking(r) {
    if (!current(r) || r.checkPending) return;
    r.checkPending = true;
    st = { ...st, state: 'checking', link: null };
    if (r.codeTimer) { clearTimer(r.codeTimer); r.codeTimer = null; }
    const signal = r.abort.signal;
    try {
      const s = await abortBound(() => status({ bin: r.bin, env: r.env, signal }),
        signal, setTimer, clearTimer, deps.checkDrainMs ?? 15000);
      if (!current(r)) return;
      if (!s || s.loggedIn !== true) { fail(r, 'error'); return; }

      try { const ca = require('./claude-auth'); if (typeof ca.clearTokenCache === 'function') ca.clearTokenCache(); } catch { /* optional */ }
      const v = await abortBound(() => verify({ signal }),
        signal, setTimer, clearTimer, deps.checkDrainMs ?? 15000);
      if (!current(r)) return;
      if (!v?.ok) { fail(r, reasonFromVerify(v)); return; }

      cleanup(r);
      st = {
        state: 'done', id: r.id, link: null, reason: null,
        message: WORDS.done, startedAt: st.startedAt
      };
    } catch {
      if (current(r)) fail(r, 'error');
    } finally {
      r.checkPending = false;
      release(r);
    }
  }

  function onData(r, d) {
    if (!current(r)) return;
    if (r.buf.length < OUTPUT_CAP) r.buf += String(d).slice(0, OUTPUT_CAP - r.buf.length);
    if (/Login successful/i.test(r.buf)) { checking(r); return; }
    if (st.state === 'starting') {
      const link = extractLink(r.buf);
      if (link) st = { ...st, state: 'link', link };
    }
    if (r.accepted && st.state === 'link') {
      // The client may stay alive after a wrong code and ask again: its answer to our code ends the attempt at once.
      if (CODE_REJECTED_RE.test(r.buf.slice(r.mark))) return fail(r, 'code');
      armCodeWait(r);   // it said something else: the wait for a verdict starts over
    }
  }
  /** After a code was handed to the client: no verdict within codeWaitMs -> failed 'error'. */
  function armCodeWait(r) {
    if (r.codeTimer) clearTimer(r.codeTimer);
    r.codeTimer = setTimer(() => { r.codeTimer = null; if (current(r) && st.state === 'link') fail(r, 'error'); }, codeWaitMs);
    if (r.codeTimer && r.codeTimer.unref) r.codeTimer.unref();
  }

  /** Find (and if need be install) the client, then start its sign-in. Runs in the background after start() answered. */
  async function proceed(r) {
    let client = null;
    try {
      client = await find();
      if (!current(r)) return;
      if (!client) {
        // Install only when no usable client exists: one the hub already resolved is never pulled out from under it.
        if (await existing()) return fail(r, 'error');
        if (!current(r)) return;
        st = { ...st, state: 'installing' };
        const installed = await install({ onChild: (c) => track(r, c) });
        // After any install, even a failed one: the installer may have moved the client, so the hub resolves it again.
        try { resetCli(); } catch { /* the loader is optional */ }
        if (installed) {
          if (!current(r)) return;
          client = await find();
        }
      }
    } catch { client = null; }
    if (!current(r)) return;
    if (!client || !client.bin) return fail(r, 'missing');
    let env;
    try { env = getEnv(); } catch { return fail(r, 'error'); }
    if (st.state === 'installing') st = { ...st, state: 'starting' };
    r.bin = client.bin; r.env = env;
    let child;
    try { child = startGroup(client.bin, ['auth', 'login', '--claudeai'], { env, spawn, kill: killProc, setTimer, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return fail(r, 'missing'); }
    r.child = child;
    track(r, child);
    if (child.stdout) child.stdout.on('data', (d) => onData(r, d));
    if (child.stderr) child.stderr.on('data', (d) => onData(r, d));
    if (child.stdin) child.stdin.on('error', () => { /* the client already left */ });
    child.on('error', () => { if (current(r) && st.state !== 'checking') fail(r, 'missing'); });
    child.on('result', (code) => {
      if (!current(r)) return;
      if (st.state === 'checking') return;
      if (code === 0 || /Login successful/i.test(r.buf)) { checking(r); return; }
      fail(r, reasonFromOutput(r.buf));
    });
  }

  /** Starts an attempt and answers at once: { ok: true, id } (or { ok: false, reason: 'busy' }). Finding and installing the
   *  client go on in the background; poll state(). */
  async function start() {
    if (busy()) return { ok: false, reason: 'busy' };
    const id = crypto.randomBytes(9).toString('base64url');
    st = { state: 'starting', id, link: null, reason: null, message: null, startedAt: now() };
    const r = { id, kids: [], buf: '', timer: null, codeTimer: null, accepted: false, mark: 0, ended: false, exitHook: null, bin: null, env: null, child: null };
    r.abort = new AbortController(); r.checkPending = false;
    run = r;
    r.timer = setTimer(() => {
      if (current(r)) fail(r, 'timeout');
    }, timeoutMs);
    if (r.timer && r.timer.unref) r.timer.unref();
    // When the hub process itself exits, no client or installer is left behind (a process-group kill is synchronous).
    r.exitHook = () => {
      r.abort.abort();
      for (const k of liveKids(r)) k.job.disconnect();
    };
    process.once('exit', r.exitHook);
    proceed(r).catch(() => { if (current(r)) fail(r, 'error'); });
    return { ok: true, id };
  }

  function submitCode(code, id) {
    if (id != null && id !== st.id) return { ok: false, reason: 'stale' };
    if (st.state !== 'link' || !run || !run.child) return { ok: false, reason: st.state === 'link' ? 'error' : 'state' };
    if (run.accepted) return { ok: false, reason: 'state' };   // one accepted code per attempt
    const c = String(code == null ? '' : code).trim();
    if (!/^[\x21-\x7e]{8,4096}$/.test(c)) return { ok: false, reason: 'format' };
    try { run.child.stdin.write(c + '\n'); } catch { return { ok: false, reason: 'error' }; }
    run.accepted = true;
    run.mark = run.buf.length;
    armCodeWait(run);
    return { ok: true };
  }

  function cancel(id) {
    if (id != null && id !== st.id) return { ok: false, reason: 'stale' };
    if (!ACTIVE.includes(st.state)) return { ok: true };
    const r = run;
    cleanup(r);
    st = { state: 'cancelled', id: st.id, link: null, reason: null, message: null, startedAt: st.startedAt };
    return { ok: true };
  }

  function state() {
    const o = { state: st.state, id: st.id, reason: st.reason, message: st.message, startedAt: st.startedAt };
    if (st.state === 'link') o.link = st.link;
    return o;
  }

  return { start, submitCode, cancel, state };
}

let _instance = null;
function getSignIn() { if (!_instance) _instance = createSignIn(); return _instance; }

module.exports = { WORDS, INSTALL_COMMAND, defaultVerify, findClient, clientEnv, configDirFromEnvFile, authStatus, installClient, existingClient, createSignIn, getSignIn, reasonFromOutput, reasonFromVerify, extractLink };
