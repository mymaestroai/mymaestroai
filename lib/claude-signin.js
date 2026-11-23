'use strict';
// The Claude sign-in engine: signs the Claude client in on the computer that runs the hub, with the client's own
// `auth login --claudeai`, so the sign-in lands where the agents' turns read it. Used by the page (later) and by
// `mymaestro connect claude`. One attempt at a time. The pasted code goes to the client's standard input and nowhere
// else: it is not stored, logged or put in state. The client's output is kept in memory only (capped) and never logged.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
const OUTPUT_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 3000;

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
function authStatus({ bin, env = process.env, timeoutMs = 20000, spawn = realSpawn, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let settled = false, out = '', child = null, timer = null;
    const finish = (v) => { if (settled) return; settled = true; if (timer) clearTimer(timer); resolve(v); };
    try {
      child = spawn(bin, ['auth', 'status', '--json'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return finish({ loggedIn: null, method: null }); }
    timer = setTimer(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ loggedIn: null, method: null }); }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => { if (out.length < OUTPUT_CAP) out += d; });
    child.on('error', () => finish({ loggedIn: null, method: null }));
    child.on('close', (code) => {
      let j = null;
      try { j = JSON.parse(out.trim()); } catch { /* no JSON */ }
      if (j && typeof j === 'object' && typeof j.loggedIn === 'boolean') return finish({ loggedIn: j.loggedIn, method: j.authMethod || null });
      if (code === 1) return finish({ loggedIn: false, method: null });
      finish({ loggedIn: null, method: null });
    });
  });
}

/** Install Claude Code with the command the Welcome page gives (linux and darwin only). true on exit 0. */
function installClient({ spawn = realSpawn, platform = process.platform, timeoutMs = 300000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve) => {
    if (platform !== 'linux' && platform !== 'darwin') return resolve(false);
    let settled = false, timer = null, child = null;
    const finish = (v) => { if (settled) return; settled = true; if (timer) clearTimer(timer); resolve(v); };
    try { child = spawn('bash', ['-c', INSTALL_COMMAND], { stdio: 'ignore' }); } catch { return finish(false); }
    timer = setTimer(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(false); }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

function reasonFromOutput(text) {
  const t = String(text || '');
  if (/invalid code|code.*(expired|invalid)/i.test(t)) return 'code';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|fetch failed|could not connect/i.test(t)) return 'network';
  return 'error';
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
  const spawn = deps.spawn || realSpawn;
  const getEnv = deps.env || (() => clientEnv(process.env));
  const now = deps.now || (() => Date.now());
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const platform = deps.platform || process.platform;
  const timeoutMs = deps.timeoutMs || DEFAULT_TIMEOUT_MS;
  const find = deps.findClient || (() => findClient({ env: process.env }));
  const install = deps.installClient || (() => installClient({ platform }));
  const status = deps.authStatus || authStatus;
  const verify = deps.verify || (() => require('./welcome').getWelcome().checkClaude({ timeoutMs: 90000 }));

  let st = { state: 'idle', link: null, reason: null, message: null, startedAt: null };
  let run = null;   // the live attempt: { child, buf, timer, killTimer, submitted, exited }

  const busy = () => ['starting', 'link', 'checking'].includes(st.state);

  function cleanup(r) {
    if (!r) return;
    if (r.timer) { clearTimer(r.timer); r.timer = null; }
    if (r.child && !r.exited) {
      try { r.child.kill('SIGTERM'); } catch { /* gone */ }
      if (!r.killTimer) {
        r.killTimer = setTimer(() => { if (!r.exited) { try { r.child.kill('SIGKILL'); } catch { /* gone */ } } }, KILL_GRACE_MS);
        if (r.killTimer && r.killTimer.unref) r.killTimer.unref();
      }
    }
    if (run === r) run = null;
  }
  function fail(r, reason) {
    if (r !== run) return;
    cleanup(r);
    st = { state: 'failed', link: null, reason, message: WORDS.failed[reason] || WORDS.failed.error, startedAt: st.startedAt };
  }
  function current(r) { return r === run; }

  async function checking(r) {
    if (!current(r) || st.state === 'checking') return;
    st = { ...st, state: 'checking', link: null };
    if (r.timer) { clearTimer(r.timer); r.timer = null; }
    try {
      const s = await status({ bin: r.bin, env: r.env });
      if (!current(r)) return;
      if (!s || s.loggedIn !== true) return fail(r, 'error');
      try { const ca = require('./claude-auth'); if (typeof ca.clearTokenCache === 'function') ca.clearTokenCache(); } catch { /* optional */ }
      const v = await verify();
      if (!current(r)) return;
      if (v && v.ok) { cleanup(r); st = { state: 'done', link: null, reason: null, message: WORDS.done, startedAt: st.startedAt }; return; }
      fail(r, reasonFromVerify(v));
    } catch { if (current(r)) fail(r, 'error'); }
  }

  function onData(r, d) {
    if (!current(r)) return;
    if (r.buf.length < OUTPUT_CAP) r.buf += String(d).slice(0, OUTPUT_CAP - r.buf.length);
    if (/Login successful/i.test(r.buf)) { checking(r); return; }
    if (st.state === 'starting') {
      const link = extractLink(r.buf);
      if (link) st = { ...st, state: 'link', link };
    }
  }

  async function start() {
    if (busy()) return { ok: false, reason: 'busy' };
    st = { state: 'starting', link: null, reason: null, message: null, startedAt: now() };
    const r = { child: null, buf: '', timer: null, killTimer: null, submitted: false, exited: false, bin: null, env: null };
    run = r;
    let client = null;
    try {
      client = await find();
      if (!client) { if (await install()) client = await find(); }
    } catch { client = null; }
    if (!current(r)) return { ok: false, reason: 'cancelled' };
    if (!client || !client.bin) { fail(r, 'missing'); return { ok: false, reason: 'missing' }; }
    let env;
    try { env = getEnv(); } catch { fail(r, 'error'); return { ok: false, reason: 'error' }; }
    r.bin = client.bin; r.env = env;
    let child;
    try { child = spawn(client.bin, ['auth', 'login', '--claudeai'], { env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { fail(r, 'missing'); return { ok: false, reason: 'missing' }; }
    r.child = child;
    r.timer = setTimer(() => { if (current(r) && st.state !== 'checking') fail(r, 'timeout'); }, timeoutMs);
    if (r.timer && r.timer.unref) r.timer.unref();
    if (child.stdout) child.stdout.on('data', (d) => onData(r, d));
    if (child.stderr) child.stderr.on('data', (d) => onData(r, d));
    if (child.stdin) child.stdin.on('error', () => { /* the client already left */ });
    child.on('error', () => { r.exited = true; if (current(r) && st.state !== 'checking') fail(r, 'missing'); });
    child.on('close', (code) => {
      r.exited = true;
      if (r.killTimer) { clearTimer(r.killTimer); r.killTimer = null; }
      if (!current(r)) return;
      if (st.state === 'checking') return;
      if (code === 0 || /Login successful/i.test(r.buf)) { checking(r); return; }
      fail(r, reasonFromOutput(r.buf));
    });
    return { ok: true };
  }

  function submitCode(code) {
    if (st.state !== 'link' || !run || !run.child) return { ok: false, reason: st.state === 'link' ? 'error' : 'state' };
    const c = String(code == null ? '' : code).trim();
    if (!/^[\x21-\x7e]{8,4096}$/.test(c)) return { ok: false, reason: 'format' };
    try { run.child.stdin.write(c + '\n'); } catch { return { ok: false, reason: 'error' }; }
    run.submitted = true;
    return { ok: true };
  }

  function cancel() {
    if (!busy()) return { ok: true };
    const r = run;
    cleanup(r);
    st = { state: 'cancelled', link: null, reason: null, message: null, startedAt: st.startedAt };
    return { ok: true };
  }

  function state() {
    const o = { state: st.state, reason: st.reason, message: st.message, startedAt: st.startedAt };
    if (st.state === 'link') o.link = st.link;
    return o;
  }

  return { start, submitCode, cancel, state };
}

let _instance = null;
function getSignIn() { if (!_instance) _instance = createSignIn(); return _instance; }

module.exports = { WORDS, INSTALL_COMMAND, findClient, clientEnv, configDirFromEnvFile, authStatus, installClient, createSignIn, getSignIn, reasonFromOutput, reasonFromVerify, extractLink };
