'use strict';
// Gmail sign-in, paste-back step (lib/skills/gmail-oauth): the pasted address is checked strictly and finishes the same
// exchange as the automatic localhost callback. No network, no real browser, no listener: the exchange is a stand-in and the
// module is loaded from a throwaway install (so its token file lands in that install's data/, never in the real one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('gmail-paste-');
const G = require(path.join(ISO.inst, 'lib', 'skills', 'gmail-oauth.js'));
test.after(() => { fs.rmSync(ISO.root, { recursive: true, force: true }); });

const NOW = 1_800_000_000_000;
const STATE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const pend = (over) => Object.assign({ state: STATE, expiresAt: NOW + 5 * 60 * 1000, used: false }, over);
const addr = (qs, base = 'http://localhost:19877/callback') => `${base}?${qs}`;
const good = addr(`state=${STATE}&code=4%2F0AbCdEf&scope=x`);

test('constants: port, path and a lifetime of at most 10 minutes', () => {
  assert.equal(G.CALLBACK_PORT, 19877);
  assert.equal(G.CALLBACK_PATH, '/callback');
  assert.ok(G.LIFETIME_MS <= 10 * 60 * 1000 && G.LIFETIME_MS >= 60 * 1000);
});

test('a good address gives the code', () => {
  const r = G.parsePastedAddress(good, pend(), NOW);
  assert.deepEqual({ ok: r.ok, code: r.code }, { ok: true, code: '4/0AbCdEf' });
  // 127.0.0.1 is as good as localhost; spaces, a line break or quotes around the paste are ignored
  assert.equal(G.parsePastedAddress(`  "${good.replace('localhost', '127.0.0.1')}"\n`, pend(), NOW).ok, true);
});

for (const [name, text, reason] of [
  ['empty', '   ', 'empty'],
  ['not an address', 'hello there', 'format'],
  ['https instead of http', good.replace('http:', 'https:'), 'scheme'],
  ['other scheme', good.replace('http:', 'ftp:'), 'scheme'],
  ['another host', good.replace('localhost', 'evil.example'), 'host'],
  ['a host that only starts with localhost', good.replace('localhost', 'localhost.evil.example'), 'host'],
  ['an address with a user name before the host', good.replace('http://', 'http://localhost:x@evil.example/#'), 'host'],
  ['wrong port', good.replace(':19877', ':8080'), 'port'],
  ['no port', good.replace(':19877', ''), 'port'],
  ['wrong path', good.replace('/callback', '/other'), 'path'],
  ['path that only starts with callback', good.replace('/callback', '/callback/x'), 'path'],
  ['no state', addr('code=4%2F0AbCdEf'), 'state'],
  ['wrong state', addr('state=ffffffffffffffffffffffffffffffff&code=4%2F0AbCdEf'), 'state'],
  ['two states', addr(`state=${STATE}&state=${STATE}&code=c`), 'state'],
  ['no code', addr(`state=${STATE}`), 'nocode'],
  ['an empty code', addr(`state=${STATE}&code=`), 'nocode'],
  ['an error from Google', addr(`state=${STATE}&error=access_denied`), 'refused'],
]) {
  test(`refused: ${name}`, () => {
    const r = G.parsePastedAddress(text, pend(), NOW);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
    assert.equal(r.code, undefined);
    assert.ok(typeof r.message === 'string' && r.message.length > 10);
  });
}

test('refused: a used sign-in, an expired one, none waiting', () => {
  assert.equal(G.parsePastedAddress(good, pend({ used: true }), NOW).reason, 'used');
  assert.equal(G.parsePastedAddress(good, pend({ expiresAt: NOW - 1 }), NOW).reason, 'expired');
  assert.equal(G.parsePastedAddress(good, pend({ expiresAt: NOW }), NOW).reason, 'expired');
  assert.equal(G.parsePastedAddress(good, null, NOW).reason, 'nopending');
});

test('refused: an error parameter from another sign-in is "different sign-in", from this one a plain refusal', () => {
  assert.equal(G.parsePastedAddress(addr('state=zzzz&error=access_denied'), pend(), NOW).reason, 'state');
  const r = G.parsePastedAddress(addr(`state=${STATE}&error=access_denied`), pend(), NOW);
  assert.match(r.message, /refused|did not|no access/i);
  assert.ok(!/access_denied/.test(r.message), 'the service\'s own text is not echoed');
});

test('messages never carry the pasted text or the code', () => {
  for (const t of [good, good.replace('localhost', 'evil.example'), addr(`state=nope&code=SECRETCODE`)]) {
    const r = G.parsePastedAddress(t, pend(), NOW);
    assert.ok(!/SECRETCODE|4%2F0AbCdEf|4\/0AbCdEf|evil\.example|localhost/.test(r.message || ''), r.message);
  }
});

// ---- the whole step: start, paste, exchange ----
const exchanges = [];
G._test.setPostForm(async (host, p, form) => { exchanges.push({ host, p, form }); return { status: 200, json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 's' } }; });
G._test.setClient({ client_id: 'cid', client_secret: 'sec' });
const stateOf = (url) => new URL(url).searchParams.get('state');

test('start gives the Google link with the same redirect, a state and a 10-minute-or-less life', async () => {
  const s = await G.startSignIn({ listener: false, open: false });
  const u = new URL(s.url);
  assert.equal(u.host, 'accounts.google.com');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:19877/callback');
  assert.equal(u.searchParams.get('state').length >= 16, true);
  assert.ok(s.expiresAt > Date.now() && s.expiresAt - Date.now() <= 10 * 60 * 1000);
  assert.equal(G.pendingView().url, s.url);
  G.cancelSignIn();
});

test('paste finishes the exchange once; a second paste of the same address is refused', async () => {
  exchanges.length = 0;
  const s = await G.startSignIn({ listener: false, open: false });
  const text = `http://localhost:19877/callback?state=${stateOf(s.url)}&code=THECODE`;
  const r = await G.submitPastedAddress(text);
  assert.equal(r.ok, true);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].host, 'oauth2.googleapis.com');
  assert.equal(exchanges[0].form.code, 'THECODE');
  assert.equal(exchanges[0].form.redirect_uri, 'http://localhost:19877/callback');
  assert.ok(exchanges[0].form.code_verifier);
  assert.equal(JSON.parse(fs.readFileSync(G.TOKEN_PATH, 'utf8')).refresh_token, 'RT');
  assert.equal(G.status().authorized, true);
  const again = await G.submitPastedAddress(text);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'used');
  assert.equal(exchanges.length, 1);
  assert.equal(G.pendingView(), null);
});

test('a new start replaces the old sign-in: the old state is refused', async () => {
  exchanges.length = 0;
  const a = await G.startSignIn({ listener: false, open: false });
  const b = await G.startSignIn({ listener: false, open: false });
  assert.notEqual(stateOf(a.url), stateOf(b.url));
  const r = await G.submitPastedAddress(`http://localhost:19877/callback?state=${stateOf(a.url)}&code=C`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'state');
  assert.equal(exchanges.length, 0);
  const ok = await G.submitPastedAddress(`http://localhost:19877/callback?state=${stateOf(b.url)}&code=C`);
  assert.equal(ok.ok, true);
});

test('a wrong paste does not use up the sign-in; the right one still works', async () => {
  exchanges.length = 0;
  const s = await G.startSignIn({ listener: false, open: false });
  assert.equal((await G.submitPastedAddress('http://localhost:19877/callback?state=bad&code=C')).ok, false);
  assert.equal((await G.submitPastedAddress(`http://example.com:19877/callback?state=${stateOf(s.url)}&code=C`)).ok, false);
  assert.equal(exchanges.length, 0);
  assert.equal((await G.submitPastedAddress(`http://localhost:19877/callback?state=${stateOf(s.url)}&code=C`)).ok, true);
});

test('a refusal from Google ends that sign-in', async () => {
  const s = await G.startSignIn({ listener: false, open: false });
  const r = await G.submitPastedAddress(`http://localhost:19877/callback?state=${stateOf(s.url)}&error=access_denied`);
  assert.equal(r.reason, 'refused');
  assert.equal(G.pendingView(), null);
  assert.equal((await G.submitPastedAddress(`http://localhost:19877/callback?state=${stateOf(s.url)}&code=C`)).ok, false);
});

test('an expired sign-in is refused and gone', async () => {
  const s = await G.startSignIn({ listener: false, open: false });
  G._test.expireNow();
  const r = await G.submitPastedAddress(`http://localhost:19877/callback?state=${stateOf(s.url)}&code=C`);
  assert.equal(r.reason, 'expired');
  assert.equal(G.pendingView(), null);
});

test('a failed exchange is a plain message without the code, and the code is spent', async () => {
  G._test.setPostForm(async () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Bad SECRETCODE' } }));
  const s = await G.startSignIn({ listener: false, open: false });
  const r = await G.submitPastedAddress(`http://localhost:19877/callback?state=${stateOf(s.url)}&code=SECRETCODE`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exchange');
  assert.ok(!/SECRETCODE/.test(r.message));
  assert.equal((await G.submitPastedAddress(`http://localhost:19877/callback?state=${stateOf(s.url)}&code=SECRETCODE`)).reason, 'used');
});

test('nothing here prints the code, a token or the pasted address', async () => {
  const seen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => seen.push(a.join(' '));
  try {
    G._test.setPostForm(async () => ({ status: 200, json: { access_token: 'ATOKEN1', refresh_token: 'RTOKEN1', expires_in: 3600 } }));
    const s = await G.startSignIn({ listener: false, open: false });
    await G.submitPastedAddress(`http://localhost:19877/callback?state=${stateOf(s.url)}&code=LOGCODE1`);
    await G.submitPastedAddress('http://localhost:19877/callback?state=bad&code=LOGCODE2');
  } finally { Object.assign(console, orig); }
  assert.ok(!/LOGCODE|ATOKEN1|RTOKEN1|state=/.test(seen.join('\n')), seen.join('\n'));
});

test('no sign-in client on this machine: start says so in plain words', async () => {
  G._test.setClient(null);
  await assert.rejects(() => G.startSignIn({ listener: false, open: false }), (e) => /not found|set up|available/i.test(e.message) && !/@internal/.test(e.userMessage || ''));
  G._test.setClient({ client_id: 'cid', client_secret: 'sec' });
});

// ---- option B: the module alone; the text it returns, no browser on this machine, an unknown state ----
test('the returned text says plainly what to do: open the link, approve, the page fails (expected), copy the WHOLE address, 10 minutes', async () => {
  G._test.setPostForm(async () => ({ status: 200, json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } }));
  G._test.setOpener(async () => false);
  const r = await G.beginSignIn({ listener: false });
  assert.equal(r.mode, 'paste');
  assert.ok(r.message.includes(r.url), 'the link is in the text');
  assert.match(r.message, /open this link/i);
  assert.match(r.message, /approve/i);
  assert.match(r.message, /fail to load/i);
  assert.match(r.message, /expected/i);
  assert.match(r.message, /whole address/i);
  assert.match(r.message, /address bar/i);
  assert.match(r.message, /send (it|the address) back/i);
  assert.match(r.message, /10 minutes/i);
  assert.ok(!/\bhub\b/i.test(r.message.replace(r.url, '')));
  assert.equal(G.getAuthUrl(), r.url);
  G.cancelSignIn();
});

test('finishWithPastedAddress is exported and finishes the sign-in once', async () => {
  assert.equal(typeof G.finishWithPastedAddress, 'function');
  G._test.setOpener(async () => false);
  const r = await G.beginSignIn({ listener: false });
  const out = await G.finishWithPastedAddress(`http://localhost:19877/callback?state=${stateOf(r.url)}&code=C1`);
  assert.equal(out.ok, true);
  assert.equal((await G.finishWithPastedAddress(`http://localhost:19877/callback?state=${stateOf(r.url)}&code=C1`)).ok, false);
});

test('canOpenBrowser: Linux needs DISPLAY or WAYLAND_DISPLAY; other systems can', () => {
  assert.equal(G.canOpenBrowser('linux', {}), false);
  assert.equal(G.canOpenBrowser('linux', { DISPLAY: '' }), false);
  assert.equal(G.canOpenBrowser('linux', { DISPLAY: ':0' }), true);
  assert.equal(G.canOpenBrowser('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(G.canOpenBrowser('darwin', {}), true);
  assert.equal(G.canOpenBrowser('win32', {}), true);
});

test('no display: the paste-back text comes back at once, without waiting on the listener', async () => {
  let opened = 0;
  G._test.setOpener(async () => { opened++; return false; });   // what openBrowser reports when there is no display
  const t0 = Date.now();
  const r = await G.beginSignIn({ listener: true, waitMs: 30000 });
  assert.ok(Date.now() - t0 < 2000, 'returned at once');
  assert.equal(r.mode, 'paste');
  assert.match(r.message, /whole address/i);
  assert.ok(G.pendingView(), 'still waiting for the pasted address');
  G.cancelSignIn();
  assert.equal(opened, 1);
});

test('the real opener says no when there is no display (Linux) and never runs a command', async () => {
  G._test.setOpener(null);
  const saved = { d: process.env.DISPLAY, w: process.env.WAYLAND_DISPLAY };
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
  try {
    if (process.platform === 'linux') {
      const t0 = Date.now();
      const r = await G.beginSignIn({ listener: false, waitMs: 30000 });
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(r.mode, 'paste');
      G.cancelSignIn();
    }
  } finally {
    if (saved.d !== undefined) process.env.DISPLAY = saved.d;
    if (saved.w !== undefined) process.env.WAYLAND_DISPLAY = saved.w;
  }
});

test('the opener fails (command missing or errors): same paste-back text at once', async () => {
  G._test.setOpener(async () => { throw new Error('spawn xdg-open ENOENT'); });
  const t0 = Date.now();
  const r = await G.beginSignIn({ listener: false, waitMs: 30000 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.mode, 'paste');
  assert.match(r.message, /open this link/i);
  G.cancelSignIn();
});

test('a browser did open: wait for the automatic finish; if it never comes, the paste-back text after the wait', async () => {
  G._test.setOpener(async () => true);
  const r = await G.beginSignIn({ listener: false, waitMs: 50 });
  assert.equal(r.mode, 'paste');
  assert.match(r.message, /whole address/i);
  // finishing by itself during the wait
  G._test.setOpener(async () => true);
  const pr = G.beginSignIn({ listener: false, waitMs: 5000 });
  await new Promise((res) => setTimeout(res, 30));
  const url = G.pendingView().url;
  await G.finishWithPastedAddress(`http://localhost:19877/callback?state=${stateOf(url)}&code=C2`);
  const done = await pr;
  assert.equal(done.mode, 'done');
  assert.match(done.message, /connected/i);
});

test('an address whose state matches no waiting sign-in is refused with "start the sign-in again"', async () => {
  G._test.setOpener(async () => false);
  const a = await G.beginSignIn({ listener: false });
  const unknown = await G.finishWithPastedAddress('http://localhost:19877/callback?state=0123456789abcdef0123456789abcdef&code=C');
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /start the (gmail )?sign-in again/i);
  assert.ok(!/0123456789abcdef/.test(unknown.message));
  assert.ok(G.pendingView(), 'the waiting sign-in is not burned');
  G.cancelSignIn();
  const none = await G.finishWithPastedAddress(`http://localhost:19877/callback?state=${stateOf(a.url)}&code=C`);
  assert.equal(none.ok, false);
  assert.match(none.message, /start the (gmail )?sign-in again/i);
});
