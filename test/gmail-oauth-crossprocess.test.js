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

test('G1: used in the file is refused and the file is emptied', async () => {
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
  assert.deepEqual(readFile(B), {});
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
