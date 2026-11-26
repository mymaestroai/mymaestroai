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
// The pending sign-in lives in one row of gmail-signin.db next to the token. These helpers use their own short-lived connections.
const Database = require('better-sqlite3');
const dbFile = (G) => path.join(path.dirname(G.TOKEN_PATH), 'gmail-signin.db');
function withDb(G, fn) { const d = new Database(dbFile(G)); try { return fn(d); } finally { d.close(); } }
/** The row as { id, state, verifier, expiresAt, used }, or null when there is none. */
const rowOf = (G) => withDb(G, (d) => {
  const r = d.prepare('SELECT id, state, verifier, expires_at, used FROM pending').get();
  return r ? { id: r.id, state: r.state, verifier: r.verifier, expiresAt: r.expires_at, used: r.used === 1 } : null;
});
const readFile = (G) => rowOf(G);
/** Replace the one row (another process's doing). */
const setRow = (G, f) => withDb(G, (d) => {
  d.prepare('DELETE FROM pending').run();
  d.prepare('INSERT INTO pending(id, state, verifier, expires_at, used) VALUES (?, ?, ?, ?, ?)').run(f.id, f.state, f.verifier, f.expiresAt, f.used ? 1 : 0);
});
const emptyRow = (G) => withDb(G, (d) => d.prepare('DELETE FROM pending').run());
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

test('G1: the database never holds the code or a token, and its mode is 0600', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  await A.beginSignIn({ listener: false });
  assert.equal(fs.statSync(dbFile(A)).mode & 0o777, 0o600);
  const cols = withDb(A, (d) => d.prepare('PRAGMA table_info(pending)').all().map((c) => c.name));
  assert.deepEqual(cols, ['id', 'state', 'verifier', 'expires_at', 'used']);
  assert.equal(withDb(A, (d) => d.prepare('SELECT COUNT(*) AS n FROM pending').get().n), 1, 'at most one row');
  const entries = fs.readdirSync(path.dirname(dbFile(A)));
  assert.ok(!entries.some((n) => /\.tmp|\.lock|signin-pending/.test(n)), 'no temp, lock or pending file left behind');
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
  setRow(A, f);
  const B = fresh(); let n = 0; B._test.setPostForm(async () => { n++; return okExchange('x')(); });
  const out = await B.finishWithPastedAddress(cb(stateOf(r.url)));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'used');
  assert.equal(n, 0);
  assert.equal(readFile(B).id, f.id);
});

test('G1: expired in the database is refused and the row is removed', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const r = await A.beginSignIn({ listener: false });
  const f = readFile(A); f.expiresAt = Date.now() - 1000;
  setRow(A, f);
  const B = fresh(); let n = 0; B._test.setPostForm(async () => { n++; return okExchange('x')(); });
  const out = await B.finishWithPastedAddress(cb(stateOf(r.url)));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'expired');
  assert.equal(n, 0);
  assert.equal(readFile(B), null);
});

test('G1: nothing in the database at all: refused as nothing waiting', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  await A.beginSignIn({ listener: false });   // creates the database
  emptyRow(A);
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
  setRow(A, f);
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
  assert.equal(readFile(A).used, true);
});

test('L1: a database lock held by someone else (and never aged out) gives a plain retryable sentence', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  const holder = new Database(dbFile(A));
  holder.exec('BEGIN IMMEDIATE');   // another process in the middle of a decision
  try {
    const t0 = Date.now();
    const out = await A.finishWithPastedAddress(cb(stateOf(a.url)));
    assert.equal(out.ok, false);
    assert.equal(out.message, 'Your Maestro is busy finishing another Gmail sign-in; try again in a moment.');
    assert.ok(Date.now() - t0 < 3000, 'the wait is short');
    await assert.rejects(() => A.beginSignIn({ listener: false }), (e) => e.userMessage === A.WORDS.busy);
  } finally { holder.exec('ROLLBACK'); holder.close(); }
  assert.equal(readFile(A).used, false, 'nothing was claimed');
});

test('L1: a decision that throws releases the lock and changes nothing (rolled back)', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  A._test.setPostForm(okExchange('boom'));
  const real = fs.writeFileSync;
  fs.writeFileSync = function (p, ...rest) {
    if (String(p) === A.TOKEN_PATH) { const e = new Error('EIO: disk gone'); e.code = 'EIO'; throw e; }
    return real.call(this, p, ...rest);
  };
  let out;
  try { out = await A.finishWithPastedAddress(cb(stateOf(a.url))); } finally { fs.writeFileSync = real; }
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'exchange');
  // The lock is free again: another instance can start, and the token file was not written.
  const B = fresh(); B._test.setOpener(async () => false);
  const b = await B.beginSignIn({ listener: false });
  assert.equal(readFile(B).state, stateOf(b.url));
  assert.ok(tokenText(A) === null || !/AT-boom/.test(tokenText(A)));
});

test('L1: the lock is the database: a holder that exits releases it (no age to wait out)', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  await A.beginSignIn({ listener: false });
  const holder = new Database(dbFile(A));
  holder.exec('BEGIN IMMEDIATE');
  holder.close();   // the process ends: the operating system lets go
  const B = fresh(); B._test.setOpener(async () => false);
  const t0 = Date.now();
  const b = await B.beginSignIn({ listener: false });
  assert.equal(readFile(B).state, stateOf(b.url));
  assert.ok(Date.now() - t0 < 400, 'no wait for a stale age');
});

test('L2: another process claimed the sign-in just before the deadline: the waiting caller is told, and the claim is not cancelled', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.startSignIn({ listener: false, open: false });
  let aSettled = null;
  a.promise.then(() => { aSettled = 'resolved'; }, (e) => { aSettled = e.message; });
  const B = fresh();
  let release;
  B._test.setPostForm(() => new Promise((res) => { release = () => res({ status: 200, json: { access_token: 'AT-L2', refresh_token: 'RT-L2', expires_in: 3600 } }); }));
  const pasting = B.finishWithPastedAddress(cb(stateOf(a.url), 'K'));
  await tick(60);
  assert.equal(readFile(A).used, true, 'B claimed it');
  const f = readFile(A); f.expiresAt = Date.now() - 1; setRow(A, f);   // the deadline passes while B's exchange runs
  await A._test.fireExpiry();
  await tick();
  assert.equal(aSettled, 'Another process is handling this Gmail sign-in. Check its result there.', 'A\'s caller gets an answer');
  assert.equal(A.lastResult(), null, 'A did not announce a timeout');
  assert.equal(A.pendingView(), null, 'A no longer waits');
  assert.equal(readFile(A).id, f.id, 'the row is still there');
  release();
  const out = await pasting;
  assert.equal(out.ok, true, 'B still saves');
  assert.equal(JSON.parse(tokenText(B)).refresh_token, 'RT-L2');
});

test('L3: a refused paste in one process never deletes a row another process claimed', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.startSignIn({ listener: false, open: false });
  let aSettled = null;
  a.promise.then(() => { aSettled = 'resolved'; }, (e) => { aSettled = e.message; });
  const B = fresh();
  let release;
  B._test.setPostForm(() => new Promise((res) => { release = () => res({ status: 200, json: { access_token: 'AT-L3', refresh_token: 'RT-L3', expires_in: 3600 } }); }));
  const pasting = B.finishWithPastedAddress(cb(stateOf(a.url), 'K'));
  await tick(60);
  assert.equal(readFile(A).used, true, 'B claimed it');
  const refused = await A.finishWithPastedAddress(`http://localhost:19877/callback?state=${stateOf(a.url)}&error=access_denied`);
  await tick();
  assert.equal(refused.ok, false);
  assert.equal(refused.message, CLAIMED_MSG, 'the submitter is told another process has it');
  assert.equal(aSettled, CLAIMED_MSG, 'the waiter is told the same');
  assert.notEqual(A.lastResult() && A.lastResult().message, A.WORDS.refused, 'no refusal is announced');
  assert.ok(readFile(A) && readFile(A).used === true, 'the claimed row is still there');
  release();
  const out = await pasting;
  assert.equal(out.ok, true, 'B still saves');
  assert.equal(JSON.parse(tokenText(B)).refresh_token, 'RT-L3');
});

const CLAIMED_MSG = 'Another process is handling this Gmail sign-in. Check its result there.';
/** Drive A's browser callback handler without a socket; resolves with the page text. */
function callbackPage(A, query) {
  return new Promise((resolve) => {
    let body = '';
    const res = { writeHead() {}, end(s) { body = String(s || ''); resolve(body); } };
    A._test.callback({ url: `/callback?${query}` }, res);
  });
}

test('L3: a refused browser callback in one process never deletes a row another process claimed, and says so on the page', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.startSignIn({ listener: false, open: false });
  let aSettled = null;
  a.promise.then(() => { aSettled = 'resolved'; }, (e) => { aSettled = e.message; });
  const B = fresh();
  let release;
  B._test.setPostForm(() => new Promise((res) => { release = () => res({ status: 200, json: { access_token: 'AT-L3c', refresh_token: 'RT-L3c', expires_in: 3600 } }); }));
  const pasting = B.finishWithPastedAddress(cb(stateOf(a.url), 'K'));
  await tick(60);
  assert.equal(readFile(A).used, true, 'B claimed it');
  const page = await callbackPage(A, `state=${stateOf(a.url)}&error=access_denied`);
  await tick();
  assert.ok(page.includes(CLAIMED_MSG), 'the page says another process has it');
  assert.equal(aSettled, CLAIMED_MSG, 'the waiter is told the same');
  assert.notEqual(A.lastResult() && A.lastResult().message, A.WORDS.refused, 'no refusal is announced');
  assert.ok(readFile(A) && readFile(A).used === true, 'the claimed row is still there');
  release();
  const out = await pasting;
  assert.equal(out.ok, true, 'B still saves');
  assert.equal(JSON.parse(tokenText(B)).refresh_token, 'RT-L3c');
});

test('L3: a refused paste or callback of an unused row removes it and reports the refusal to everyone', async () => {
  for (const via of ['paste', 'callback']) {
    const A = fresh();
    A._test.setOpener(async () => false);
    const a = await A.startSignIn({ listener: false, open: false });
    let aSettled = null;
    a.promise.then(() => { aSettled = 'resolved'; }, (e) => { aSettled = e.message; });
    const q = `state=${stateOf(a.url)}&error=access_denied`;
    let text;
    if (via === 'paste') text = (await A.finishWithPastedAddress(`http://localhost:19877/callback?${q}`)).message;
    else text = await callbackPage(A, q);
    await tick();
    assert.ok(text.includes(A.WORDS.refused), `${via}: refusal wording`);
    assert.equal(aSettled, via === 'paste' ? 'auth refused' : 'refused', `${via}: waiter rejected`);
    assert.equal(A.lastResult().message, A.WORDS.refused);
    assert.equal(readFile(A), null, `${via}: row removed`);
  }
});

test('L2: a newer sign-in replaced the row before the deadline: the waiting caller is told, the newer row is left alone', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.startSignIn({ listener: false, open: false });
  let aSettled = null;
  a.promise.then(() => { aSettled = 'resolved'; }, (e) => { aSettled = e.message; });
  setRow(A, { id: 'newer', state: 'ns', verifier: 'nv', expiresAt: Date.now() + 60000, used: false });
  await A._test.fireExpiry();
  await tick();
  assert.equal(aSettled, A.WORDS.replaced);
  assert.equal(readFile(A).id, 'newer', 'the other process\'s row is untouched');
});

test('L2: nobody claimed it and the deadline passed: the timer removes the row and ends the attempt', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.startSignIn({ listener: false, open: false });
  let settled = null;
  a.promise.then(() => { settled = 'resolved'; }, (e) => { settled = e.message; });
  const f = readFile(A); f.expiresAt = Date.now() - 1; setRow(A, f);
  await A._test.fireExpiry();
  await tick();
  assert.equal(settled, 'auth timed out');
  assert.equal(A.lastResult().message, A.WORDS.expired);
  assert.equal(readFile(A), null);
});

test('L2: a timer that fires before the row deadline removes nothing', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.startSignIn({ listener: false, open: false });
  let settled = null;
  a.promise.then(() => { settled = 'resolved'; }, (e) => { settled = e.message; });
  await A._test.fireExpiry();
  await tick();
  assert.equal(settled, null);
  assert.ok(readFile(A) && readFile(A).used === false);
  assert.ok(A.pendingView(), 'still waiting');
  A.cancelSignIn();
});

test('G4: saving under the lock refuses an attempt that was replaced during the exchange', async () => {
  const A = fresh();
  A._test.setOpener(async () => false);
  const a = await A.beginSignIn({ listener: false });
  const before = tokenText(A);
  A._test.setPostForm(async () => {
    setRow(A, { id: 'other', state: 'ss', verifier: 'vv', expiresAt: Date.now() + 60000, used: false });
    return { status: 200, json: { access_token: 'AT-R', refresh_token: 'RT-R', expires_in: 3600 } };
  });
  const out = await A.finishWithPastedAddress(cb(stateOf(a.url)));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'replaced');
  assert.equal(tokenText(A), before);
});

test('G5: no link and no browser when the sign-in cannot be saved', async () => {
  const A = fresh();
  let opened = 0;
  A._test.setOpener(async () => { opened++; return true; });
  // The database cannot be opened (a folder sits where it should be): the sign-in cannot be saved.
  const bak = `${dbFile(A)}.aside`;
  if (fs.existsSync(dbFile(A))) fs.renameSync(dbFile(A), bak);
  fs.mkdirSync(dbFile(A));
  try {
    await assert.rejects(() => A.beginSignIn({ listener: false }), (e) => e.message === 'Could not save the Gmail sign-in. Check the data folder and try again.');
  } finally {
    fs.rmdirSync(dbFile(A));
    if (fs.existsSync(bak)) fs.renameSync(bak, dbFile(A));
  }
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

const heading = (page) => (/<h2>([^<]*)<\/h2>/.exec(page) || [])[1];

test('r6: the browser page heading is neutral when the outcome is claimed elsewhere or replaced, and a failure only when confirmed', async () => {
  // claimed by another process
  {
    const A = fresh(); A._test.setOpener(async () => false);
    const a = await A.startSignIn({ listener: false, open: false });
    a.promise.catch(() => {});
    const B = fresh();
    let release;
    B._test.setPostForm(() => new Promise((res) => { release = () => res({ status: 200, json: { access_token: 'AT-r6', refresh_token: 'RT-r6', expires_in: 3600 } }); }));
    const pasting = B.finishWithPastedAddress(cb(stateOf(a.url), 'K'));
    await tick(60);
    const page = await callbackPage(A, `state=${stateOf(a.url)}&error=access_denied`);
    assert.equal(heading(page), 'Gmail sign-in', 'claimed: neutral heading');
    assert.ok(page.includes(CLAIMED_MSG));
    release(); await pasting;
  }
  // r7: a VALID code reaching A's callback after B claimed the sign-in: neutral heading, and B still saves
  {
    const A = fresh(); A._test.setOpener(async () => false);
    const a = await A.startSignIn({ listener: false, open: false });
    a.promise.catch(() => {});
    const B = fresh();
    let release;
    B._test.setPostForm(() => new Promise((res) => { release = () => res({ status: 200, json: { access_token: 'AT-r7', refresh_token: 'RT-r7', expires_in: 3600 } }); }));
    const pasting = B.finishWithPastedAddress(cb(stateOf(a.url), 'K'));
    await tick(60);
    const page = await callbackPage(A, `state=${stateOf(a.url)}&code=K`);
    assert.equal(heading(page), 'Gmail sign-in', 'valid code after a claim elsewhere: neutral heading');
    release();
    const r = await pasting;
    assert.equal(r.ok, true, 'B still saves its token');
  }
  // replaced by a newer row
  {
    const A = fresh(); A._test.setOpener(async () => false);
    const a = await A.startSignIn({ listener: false, open: false });
    a.promise.catch(() => {});
    setRow(A, { id: 'newer6', state: 'ns', verifier: 'nv', expiresAt: Date.now() + 60000, used: false });
    const page = await callbackPage(A, `state=${stateOf(a.url)}&error=access_denied`);
    assert.equal(heading(page), 'Gmail sign-in', 'replaced: neutral heading');
  }
  // confirmed refusal
  {
    const A = fresh(); A._test.setOpener(async () => false);
    const a = await A.startSignIn({ listener: false, open: false });
    a.promise.catch(() => {});
    const page = await callbackPage(A, `state=${stateOf(a.url)}&error=access_denied`);
    assert.match(heading(page), /not connected/);
  }
});

test('r6: decideEnd returns the distinct reason for removed, claimed, replaced', async () => {
  const A = fresh(); A._test.setOpener(async () => false);
  const a = await A.startSignIn({ listener: false, open: false });
  a.promise.catch(() => {});
  const p = A._test.current();
  setRow(A, { id: 'other6', state: 'ns', verifier: 'nv', expiresAt: Date.now() + 60000, used: false });
  assert.equal((await A._test.decideEnd(p, false)).reason, 'replaced');
  setRow(A, { id: p.id, state: p.state, verifier: p.verifier, expiresAt: Date.now() + 60000, used: true });
  assert.equal((await A._test.decideEnd(p, false)).reason, 'claimed');
  setRow(A, { id: p.id, state: p.state, verifier: p.verifier, expiresAt: Date.now() + 60000, used: false });
  assert.equal((await A._test.decideEnd(p, false)).reason, 'removed');
});

test('r6: the guarded delete touches no row while the row is still unused (clock moved back): retry, waiter stays alive', async () => {
  const A = fresh(); A._test.setOpener(async () => false);
  const a = await A.startSignIn({ listener: false, open: false });
  let aSettled = null;
  a.promise.then(() => { aSettled = 'resolved'; }, (e) => { aSettled = e.message; });
  A._test.expireNow();   // this process thinks the deadline passed; the file row's deadline is still ahead
  const out = await A.finishWithPastedAddress(cb(stateOf(a.url), 'K'));
  await tick();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'retry');
  assert.equal(out.message, 'Please try again in a moment.');
  assert.equal(aSettled, null, 'the waiter is still waiting');
  assert.ok(readFile(A) && readFile(A).used === false, 'the row is still there');
  assert.notEqual(A.lastResult() && A.lastResult().state, 'failed');
});
