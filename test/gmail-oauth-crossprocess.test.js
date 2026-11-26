'use strict';
// Gmail sign-in across processes (lib/skills/gmail-oauth): a sign-in begun in one node run is finished in a later one through a
// small file next to the token (state, verifier, expiry, used flag; never the code or tokens). Single use across processes, and
// an older sign-in never overwrites a newer one. No network, no browser, no listener: the exchange is a stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('gmail-xproc-');
const MOD = path.join(ISO.inst, 'lib', 'skills', 'gmail-oauth.js');
test.after(() => { fs.rmSync(ISO.root, { recursive: true, force: true }); });

/** A fresh module instance, as a new node run would have. */
function fresh() {
  delete require.cache[require.resolve(MOD)];
  const G = require(MOD);
  G._test.setClient({ client_id: 'cid', client_secret: 'sec' });
  return G;
}
const stateOf = (url) => new URL(url).searchParams.get('state');
const okExchange = (tag) => async () => ({ status: 200, json: { access_token: `AT-${tag}`, refresh_token: `RT-${tag}`, expires_in: 3600 } });
const pendingFile = (G) => path.join(path.dirname(G.TOKEN_PATH), 'gmail-signin-pending.json');
const readFile = (G) => JSON.parse(fs.readFileSync(pendingFile(G), 'utf8'));
const cb = (state, code = 'C') => `http://localhost:19877/callback?state=${state}&code=${code}`;

test('G1: begin in one module instance, finish in a fresh one', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const r = await A.beginSignIn({ listener: false });
  assert.equal(r.mode, 'paste');
  const file = readFile(A);
  assert.equal(file.state, stateOf(r.url));
  assert.ok(file.verifier && file.expiresAt > Date.now() && file.used === false);
  const B = fresh();
  assert.notEqual(A, B);
  const forms = [];
  B._test.setPostForm(async (h, p, form) => { forms.push(form); return okExchange('one')(); });
  const out = await B.finishWithPastedAddress(cb(stateOf(r.url), 'THECODE'));
  assert.equal(out.ok, true);
  assert.equal(forms.length, 1);
  assert.equal(forms[0].code, 'THECODE');
  assert.equal(forms[0].code_verifier, file.verifier);
  assert.equal(JSON.parse(fs.readFileSync(B.TOKEN_PATH, 'utf8')).refresh_token, 'RT-one');
});

test('G1: the file never holds the code or a token, and its mode is 0600', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  await A.beginSignIn({ listener: false });
  const mode = fs.statSync(pendingFile(A)).mode & 0o777;
  assert.equal(mode, 0o600);
  const text = fs.readFileSync(pendingFile(A), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)).filter((k) => !['id', 'state', 'verifier', 'expiresAt', 'used'].includes(k)), []);
  const entries = fs.readdirSync(path.dirname(pendingFile(A)));
  assert.ok(!entries.some((n) => /\.tmp/.test(n)), 'no temp file left behind');
});

test('G1: a second fresh instance cannot use a sign-in a first one already used', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const r = await A.beginSignIn({ listener: false });
  const B = fresh(); B._test.setPostForm(okExchange('b'));
  assert.equal((await B.finishWithPastedAddress(cb(stateOf(r.url)))).ok, true);
  const C = fresh(); let n = 0; C._test.setPostForm(async () => { n++; return okExchange('c')(); });
  const again = await C.finishWithPastedAddress(cb(stateOf(r.url)));
  assert.equal(again.ok, false);
  assert.equal(n, 0);
});

test('G1: used in the file is refused (the file is left alone, see G3)', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const r = await A.beginSignIn({ listener: false });
  const f = readFile(A); f.used = true;
  fs.writeFileSync(pendingFile(A), JSON.stringify(f), { mode: 0o600 });
  const B = fresh(); let n = 0; B._test.setPostForm(async () => { n++; return okExchange('x')(); });
  const out = await B.finishWithPastedAddress(cb(stateOf(r.url)));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'used');
  assert.equal(n, 0);
  assert.equal(readFile(B).id, f.id);
});

test('G1: expired in the file is refused and the file is emptied', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const r = await A.beginSignIn({ listener: false });
  const f = readFile(A); f.expiresAt = Date.now() - 1000;
  fs.writeFileSync(pendingFile(A), JSON.stringify(f), { mode: 0o600 });
  const B = fresh(); let n = 0; B._test.setPostForm(async () => { n++; return okExchange('x')(); });
  const out = await B.finishWithPastedAddress(cb(stateOf(r.url)));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'expired');
  assert.equal(n, 0);
  assert.deepEqual(readFile(B), {});
});

test('G1: nothing in the file at all: refused as nothing waiting', async () => {
  const A = fresh();
  fs.writeFileSync(pendingFile(A), '{}', { mode: 0o600 });
  const out = await A.finishWithPastedAddress(cb('0123456789abcdef0123456789abcdef'));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'nopending');
});

test('G2: an older sign-in whose exchange ends after a newer one started drops its result', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  const before = fs.existsSync(A.TOKEN_PATH) ? fs.readFileSync(A.TOKEN_PATH, 'utf8') : null;
  let release;
  A._test.setPostForm(() => new Promise((res) => { release = () => res({ status: 200, json: { access_token: 'AT-OLD', refresh_token: 'RT-OLD', expires_in: 3600 } }); }));
  const pasting = A.finishWithPastedAddress(cb(stateOf(a.url)));
  await new Promise((r) => setTimeout(r, 20));
  const b = await A.beginSignIn({ listener: false });
  assert.notEqual(stateOf(a.url), stateOf(b.url));
  release();
  const out = await pasting;
  assert.equal(out.ok, false);
  assert.equal(out.message, 'That sign-in was replaced by a newer one.');
  const after = fs.existsSync(A.TOKEN_PATH) ? fs.readFileSync(A.TOKEN_PATH, 'utf8') : null;
  assert.equal(after, before, 'the old token was not saved');
  assert.equal(A.lastResult(), null, 'the shared outcome was not set by the old one');
  assert.equal(readFile(A).state, stateOf(b.url), 'the newer sign-in is still the one on file');
  assert.ok(A.pendingView(), 'the newer sign-in is still waiting');
});

test('G2: a cancelled sign-in whose exchange ends later drops its result too', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  const before = fs.existsSync(A.TOKEN_PATH) ? fs.readFileSync(A.TOKEN_PATH, 'utf8') : null;
  let release;
  A._test.setPostForm(() => new Promise((res) => { release = () => res({ status: 200, json: { access_token: 'AT-CXL', refresh_token: 'RT-CXL', expires_in: 3600 } }); }));
  const pasting = A.finishWithPastedAddress(cb(stateOf(a.url)));
  await new Promise((r) => setTimeout(r, 20));
  A.cancelSignIn();
  release();
  const out = await pasting;
  assert.equal(out.ok, false);
  assert.match(out.message, /replaced|cancel/i);
  assert.equal(fs.existsSync(A.TOKEN_PATH) ? fs.readFileSync(A.TOKEN_PATH, 'utf8') : null, before);
  assert.equal(A.lastResult(), null);
});

test('G2: a newer sign-in started in another process also drops the older one', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  const before = fs.existsSync(A.TOKEN_PATH) ? fs.readFileSync(A.TOKEN_PATH, 'utf8') : null;
  let release;
  A._test.setPostForm(() => new Promise((res) => { release = () => res({ status: 200, json: { access_token: 'AT-X', refresh_token: 'RT-X', expires_in: 3600 } }); }));
  const pasting = A.finishWithPastedAddress(cb(stateOf(a.url)));
  await new Promise((r) => setTimeout(r, 20));
  const P = fresh(); P._test.setOpener(async () => false);
  await P.beginSignIn({ listener: false });   // another process starts B
  release();
  const out = await pasting;
  assert.equal(out.ok, false);
  assert.equal(out.message, 'That sign-in was replaced by a newer one.');
  assert.equal(fs.existsSync(A.TOKEN_PATH) ? fs.readFileSync(A.TOKEN_PATH, 'utf8') : null, before);
});

test('an address without a scheme is accepted (localhost and 127.0.0.1)', () => {
  const G = fresh();
  const S = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const pend = { state: S, expiresAt: Date.now() + 60000, used: false };
  assert.deepEqual(G.parsePastedAddress(`localhost:19877/callback?state=${S}&code=K1`, pend).code, 'K1');
  assert.deepEqual(G.parsePastedAddress(`127.0.0.1:19877/callback?state=${S}&code=K2`, pend).code, 'K2');
  assert.equal(G.parsePastedAddress(`evil.example:19877/callback?state=${S}&code=K3`, pend).ok, false);
});

test('beginSignIn with a browser that opened returns the paste-back steps at once; the listener finishes in the background', async () => {
  const A = fresh();
  A._test.setOpener(async () => true);
  const t0 = Date.now();
  const r = await A.beginSignIn({ listener: false });
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the localhost page');
  assert.equal(r.mode, 'paste');
  assert.match(r.message, /whole address/i);
  assert.ok(A.pendingView(), 'still waiting');
  A._test.setPostForm(okExchange('bg'));
  assert.equal((await A.finishWithPastedAddress(cb(stateOf(r.url)))).ok, true);
});

// ── Round 2 ──────────────────────────────────────────────────────────────
const lockFile = (G) => path.join(path.dirname(G.TOKEN_PATH), 'gmail-signin.lock');
const tokenText = (G) => (fs.existsSync(G.TOKEN_PATH) ? fs.readFileSync(G.TOKEN_PATH, 'utf8') : null);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('G3: the same address submitted twice while the exchange answers: one token saved, the second is "already used"', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  let release; let calls = 0;
  A._test.setPostForm(() => { calls++; return new Promise((res) => { release = () => res({ status: 200, json: { access_token: 'AT-G3', refresh_token: 'RT-G3', expires_in: 3600 } }); }); });
  const first = A.finishWithPastedAddress(cb(stateOf(a.url), 'ONE'));
  await tick();
  const second = await A.finishWithPastedAddress(cb(stateOf(a.url), 'ONE'));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'used');
  assert.match(second.message, /already used/);
  assert.equal(readFile(A).id !== undefined, true, 'the duplicate did not empty the file');
  release();
  const out = await first;
  assert.equal(out.ok, true, 'the first exchange still saves its token');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(tokenText(A)).refresh_token, 'RT-G3');
});

test('G3: a used sign-in read from the file by finishWithCode is refused without emptying the file', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const r = await A.beginSignIn({ listener: false });
  const f = readFile(A); f.used = true;
  fs.writeFileSync(pendingFile(A), JSON.stringify(f), { mode: 0o600 });
  const B = fresh(); let n = 0; B._test.setPostForm(async () => { n++; return okExchange('x')(); });
  const out = await B.finishWithPastedAddress(cb(stateOf(r.url)));
  assert.equal(out.reason, 'used');
  assert.equal(n, 0);
  assert.equal(readFile(B).id, f.id, 'a duplicate is read-only');
});

test('G4: two module instances claim the same sign-in at once: exactly one wins', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  const B = fresh(); const C = fresh();
  let n = 0; const rel = [];
  for (const G of [B, C]) G._test.setPostForm(() => { n++; return new Promise((res) => { rel.push(() => res({ status: 200, json: { access_token: 'AT-W', refresh_token: 'RT-W', expires_in: 3600 } })); }); });
  const pb = B.finishWithPastedAddress(cb(stateOf(a.url), 'K'));
  const pc = C.finishWithPastedAddress(cb(stateOf(a.url), 'K'));
  await tick(150);
  rel.forEach((f) => f());
  const outs = await Promise.all([pb, pc]);
  assert.equal(n, 1, 'one exchange only');
  assert.equal(outs.filter((o) => o.ok).length, 1);
  assert.equal(outs.filter((o) => !o.ok)[0].reason, 'used');
  assert.ok(!fs.existsSync(lockFile(A)), 'the lock is released');
});

test('G4: a lock older than 30 seconds is taken over', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  fs.writeFileSync(lockFile(A), JSON.stringify({ pid: 1, at: Date.now() - 60000 }), { mode: 0o600 });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile(A), old, old);
  const r = await A.beginSignIn({ listener: false });
  assert.equal(r.mode, 'paste');
  assert.ok(readFile(A).state === stateOf(r.url));
  assert.ok(!fs.existsSync(lockFile(A)), 'the lock is released after the start');
});

test('G4: a fresh lock held by someone else gives a plain retryable sentence', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  fs.writeFileSync(lockFile(A), JSON.stringify({ pid: 2, at: Date.now() }), { mode: 0o600 });
  try {
    const out = await A.finishWithPastedAddress(cb(stateOf(a.url)));
    assert.equal(out.ok, false);
    assert.equal(out.message, 'Your Maestro is busy finishing another Gmail sign-in; try again in a moment.');
    assert.equal(readFile(A).used, false, 'nothing was claimed');
  } finally { fs.unlinkSync(lockFile(A)); }
});

test('G4: saving under the lock refuses an attempt that was replaced during the exchange', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  const before = tokenText(A);
  A._test.setPostForm(async () => {
    fs.writeFileSync(pendingFile(A), JSON.stringify({ id: 'other', state: 'ss', verifier: 'vv', expiresAt: Date.now() + 60000, used: false }), { mode: 0o600 });
    return { status: 200, json: { access_token: 'AT-R', refresh_token: 'RT-R', expires_in: 3600 } };
  });
  const out = await A.finishWithPastedAddress(cb(stateOf(a.url)));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'replaced');
  assert.equal(tokenText(A), before);
  assert.ok(!fs.existsSync(lockFile(A)));
});

test('G5: no link and no browser when the sign-in cannot be saved', async () => {
  const A = fresh();
  let opened = 0;
  A._test.setOpener(async () => { opened++; return true; });
  const real = fs.writeFileSync;
  fs.writeFileSync = function (p, ...rest) {
    if (/gmail-signin-pending/.test(String(p))) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return real.call(this, p, ...rest);
  };
  try {
    await assert.rejects(() => A.beginSignIn({ listener: false }), (e) => e.message === 'Could not save the Gmail sign-in. Check the data folder and try again.');
  } finally { fs.writeFileSync = real; }
  assert.equal(opened, 0);
  assert.equal(A.pendingView(), null);
  assert.equal(A.getAuthUrl(), null);
});

test('follow-up: a newer sign-in found in the file ends the old in-memory attempt', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const s = await A.startSignIn({ listener: false, open: false });
  let settled = null;
  s.promise.then(() => { settled = 'resolved'; }, (e) => { settled = e.message; });
  const P = fresh(); P._test.setOpener(async () => false);
  await P.beginSignIn({ listener: false });   // another process starts a newer one
  const out = await A.submitPastedAddress('http://localhost:19877/callback?state=zz&code=Q');
  assert.equal(out.ok, false);
  await tick();
  assert.equal(settled, 'replaced', 'the old attempt was rejected');
});
