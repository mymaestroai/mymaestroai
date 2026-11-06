'use strict';
// Face ID / fingerprint unlock of the wallet, browser side (2026-11): lib/ui-passkey.js holds the helpers; the pages
// carry byte-identical copies between the markers and the desktop Wallet panel uses them.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pkB64u, pkBytes, pkUsable, pkErrorText, pkUnlock, pkAdd, pkDeviceLabel } = require('../lib/ui-passkey');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── passkey helpers (begin) ──';
const END = '// ── passkey helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}
function block(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${from} not found`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `${to} not found after ${from}`);
  return src.slice(a, b);
}

// A stand-in navigator for the tests below; the real one is put back afterwards.
const realNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function withNavigator(nav, fn) {
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  const done = () => { if (realNav) Object.defineProperty(globalThis, 'navigator', realNav); else delete globalThis.navigator; };
  return Promise.resolve().then(fn).then((r) => { done(); return r; }, (e) => { done(); throw e; });
}
const u8 = (...a) => new Uint8Array(a);
const b64 = (...a) => pkB64u(u8(...a));
// An api stand-in that records every call and answers from a table by path (a function answers with its body).
function fakeApi(answers) {
  const calls = [];
  const api = async (p, body) => { calls.push([p, body]); const a = answers[p]; return typeof a === 'function' ? a(body) : a; };
  api.calls = calls;
  return api;
}
const ext = (prf) => () => ({ prf });

test('the pages carry the helpers byte for byte', () => {
  const lib = helperBlock(read('lib/ui-passkey.js'), '');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy');
});

test('base64url: round trip of every byte value, no padding, url-safe alphabet', () => {
  const all = new Uint8Array(256).map((_, i) => i);
  const s = pkB64u(all);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(s), 'url-safe, no padding');
  assert.deepStrictEqual(Array.from(pkBytes(s)), Array.from(all));
  assert.strictEqual(pkB64u(all.buffer), s, 'an ArrayBuffer works too');
  for (let n = 0; n < 8; n++) {
    const b = all.slice(250 - n, 250);
    const t = pkB64u(b);
    assert.ok(!t.includes('='), `length ${n}`);
    assert.deepStrictEqual(Array.from(pkBytes(t)), Array.from(b), `length ${n}`);
  }
  assert.strictEqual(pkB64u(u8(251, 255, 254)), '-__-');
  assert.strictEqual(pkB64u(new Uint8Array(0)), '');
  assert.strictEqual(pkBytes('').length, 0);
});

test('pkUsable: no API, an address number, a plain http name, https and localhost', () => {
  const win = { PublicKeyCredential: function PublicKeyCredential() {} };
  const at = (protocol, hostname) => ({ protocol, hostname });
  return withNavigator({ credentials: {} }, () => {
    let r = pkUsable(at('https:', 'hub.example.ts.net'), {});
    assert.deepStrictEqual([r.ok, r.code, r.text], [false, 'no_api', "This browser can't use passkeys."]);
    r = pkUsable(at('https:', 'hub.example.ts.net'), win);
    assert.deepStrictEqual(r, { ok: true, code: '', text: '' });
    r = pkUsable(at('http:', '127.0.0.1'), win);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'bad_address');
    assert.ok(r.text.includes('127.0.0.1') && r.text.includes('tailnet') && r.text.includes('(https)'), r.text);
    r = pkUsable(at('https:', '192.168.0.10'), win);
    assert.strictEqual(r.code, 'bad_address', 'a number is refused even over https');
    r = pkUsable(at('http:', '[::1]'), win);
    assert.strictEqual(r.code, 'bad_address'); assert.ok(r.text.includes('[::1]'));
    r = pkUsable(at('http:', 'hub.example.ts.net'), win);
    assert.strictEqual(r.code, 'bad_address'); assert.strictEqual(r.text, "Face ID and fingerprint need My Maestro's secure (https) address.");
    r = pkUsable(at('http:', 'localhost'), win);
    assert.strictEqual(r.ok, false, 'localhost is not usable any more'); assert.strictEqual(r.code, 'bad_address');
    assert.strictEqual(r.text, "Face ID and fingerprint work on My Maestro's secure tailnet address (https), not on localhost.");
    assert.strictEqual(pkUsable(at('https:', 'localhost'), win).ok, false, 'not even over https');
    assert.strictEqual(pkUsable(at('https:', 'hub.localhost'), win).ok, false, '*.localhost too');
    assert.strictEqual(pkUsable(at('https:', 'hub.example.ts.net'), win).ok, true);
  }).then(() => withNavigator({}, () => {
    assert.strictEqual(pkUsable({ protocol: 'https:', hostname: 'hub.example.ts.net' }, win).code, 'no_api', 'no navigator.credentials');
  }));
});

test('pkErrorText: plain sentences for the usual errors', () => {
  assert.strictEqual(pkErrorText({ name: 'NotAllowedError', message: 'x' }), 'Cancelled, or the device did not confirm it was you.');
  assert.strictEqual(pkErrorText({ name: 'InvalidStateError' }), 'This device is already set up.');
  assert.strictEqual(pkErrorText({ name: 'SecurityError' }), "This address can't use passkeys.");
  assert.strictEqual(pkErrorText({ name: 'AbortError' }), 'Cancelled.');
  assert.strictEqual(pkErrorText(new Error('Wrong passphrase.')), 'Wrong passphrase.');
  assert.strictEqual(pkErrorText({}), 'Something went wrong.');
  assert.strictEqual(pkErrorText(null), 'Something went wrong.');
});

test('pkDeviceLabel: a short name from the platform or the user agent', () => {
  const ua = (userAgent, extra = {}) => ({ userAgent, ...extra });
  assert.strictEqual(pkDeviceLabel(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15')), 'iPhone');
  assert.strictEqual(pkDeviceLabel(ua('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')), 'iPad');
  assert.strictEqual(pkDeviceLabel(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { maxTouchPoints: 5 })), 'iPad', 'iPadOS says Macintosh');
  assert.strictEqual(pkDeviceLabel(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { maxTouchPoints: 0 })), 'Mac');
  assert.strictEqual(pkDeviceLabel(ua('Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120 Mobile')), 'Android phone');
  assert.strictEqual(pkDeviceLabel(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')), 'Windows PC');
  assert.strictEqual(pkDeviceLabel(ua('Mozilla/5.0 (X11; Linux x86_64)')), 'Linux computer');
  assert.strictEqual(pkDeviceLabel(ua('', { userAgentData: { platform: 'macOS' } })), 'Mac');
  assert.strictEqual(pkDeviceLabel(ua('', { userAgentData: { platform: 'Windows' } })), 'Windows PC');
  assert.strictEqual(pkDeviceLabel(ua('', { userAgentData: { platform: 'Android' } })), 'Android phone');
  assert.strictEqual(pkDeviceLabel(ua('', { userAgentData: { platform: 'Linux' } })), 'Linux computer');
  assert.strictEqual(pkDeviceLabel(ua('SomethingElse/1.0')), 'This device');
  assert.strictEqual(pkDeviceLabel({}), 'This device');
});

const WORDING = "Unlock the wallet with Face ID, a fingerprint or the screen lock instead of typing the passphrase. Add each device once with the passphrase. Your device's password manager may copy the passkey to your other devices; each one still asks for your face, fingerprint or screen lock.";
const REMOVE_CONFIRM_JS = `Remove "\${label}"? It will stop unlocking this wallet. Copies of the wallet file made before now still accept it, protected by that passkey's own Face ID, fingerprint or screen lock.`;
const STRAY =' A passkey named "My Maestro wallet" may have been saved on this device; you can delete it in its password manager.';
const ID1 = b64(1, 2, 3), ID2 = b64(4, 5, 6), SALT1 = b64(10, 11), SALT2 = b64(12, 13);
const unlockOptions = (ids) => ({
  challenge: b64(9, 9, 9), rpId: 'hub.example.ts.net', timeout: 120000, userVerification: 'required',
  allowCredentials: ids.map(id => ({ type: 'public-key', id })), prfSalts: { [ID1]: SALT1, [ID2]: SALT2 },
});
const assertion = (prf) => ({
  id: ID1, rawId: u8(1, 2, 3).buffer,
  response: { clientDataJSON: u8(1).buffer, authenticatorData: u8(2).buffer, signature: u8(3).buffer },
  getClientExtensionResults: () => (prf ? { prf: { results: { first: prf } } } : {}),
});

test('pkUnlock: one passkey sends eval and evalByCredential; the answer goes to passkey/unlock', async () => {
  const gets = [];
  const nav = { credentials: { get: async (o) => { gets.push(o); return assertion(u8(7, 7, 7).buffer); } } };
  const api = fakeApi({ 'passkey/options': unlockOptions([ID1]), 'passkey/unlock': { keystore: { unlocked: true } } });
  const out = await withNavigator(nav, () => pkUnlock(api));
  assert.deepStrictEqual(out, { keystore: { unlocked: true } });
  assert.deepStrictEqual(api.calls[0], ['passkey/options', { purpose: 'unlock' }]);
  const pk = gets[0].publicKey;
  assert.deepStrictEqual(Array.from(pk.challenge), [9, 9, 9]);
  assert.strictEqual(pk.rpId, 'hub.example.ts.net'); assert.strictEqual(pk.timeout, 120000); assert.strictEqual(pk.userVerification, 'required');
  assert.strictEqual(pk.allowCredentials.length, 1);
  assert.strictEqual(pk.allowCredentials[0].type, 'public-key'); assert.deepStrictEqual(Array.from(pk.allowCredentials[0].id), [1, 2, 3]);
  assert.deepStrictEqual(Array.from(pk.extensions.prf.eval.first), [10, 11], 'a single passkey also gets eval');
  assert.deepStrictEqual(Array.from(pk.extensions.prf.evalByCredential[ID1].first), [10, 11]);
  assert.deepStrictEqual(api.calls[1], ['passkey/unlock', {
    challenge: b64(9, 9, 9), id: ID1, clientDataJSON: b64(1), authenticatorData: b64(2), signature: b64(3), prf: b64(7, 7, 7),
  }]);
});

test('pkUnlock: several passkeys send evalByCredential only; no PRF result is refused before passkey/unlock', async () => {
  const gets = [];
  const nav = { credentials: { get: async (o) => { gets.push(o); return assertion(null); } } };
  const api = fakeApi({ 'passkey/options': unlockOptions([ID1, ID2]), 'passkey/unlock': {} });
  await assert.rejects(withNavigator(nav, () => pkUnlock(api)), { message: "This device didn't give the unlock secret. Use the passphrase instead." });
  const prf = gets[0].publicKey.extensions.prf;
  assert.strictEqual('eval' in prf, false);
  assert.deepStrictEqual(Object.keys(prf.evalByCredential).sort(), [ID1, ID2].sort());
  assert.deepStrictEqual(Array.from(prf.evalByCredential[ID2].first), [12, 13]);
  assert.deepStrictEqual(api.calls.map(c => c[0]), ['passkey/options'], 'nothing sent to the hub');
});

const registerOptions = () => ({
  challenge: b64(8, 8), rp: { id: 'hub.example.ts.net', name: 'My Maestro' }, user: { id: b64(5, 5), name: 'owner', displayName: 'owner' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
  timeout: 120000, attestation: 'none', authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
  excludeCredentials: [{ type: 'public-key', id: ID2 }], prfSalt: SALT1,
});
const created = (extension, pub = u8(30, 31).buffer) => ({
  id: ID1, rawId: u8(1, 2, 3).buffer,
  response: {
    clientDataJSON: u8(20).buffer, getAuthenticatorData: () => u8(21).buffer, getPublicKeyAlgorithm: () => -7,
    ...(pub ? { getPublicKey: () => pub } : {}),
  },
  getClientExtensionResults: () => ({ prf: extension }),
});

test('pkAdd: the PRF output from create is used directly (no confirm step, no second prompt)', async () => {
  const creates = [], gets = [];
  const nav = { credentials: { create: async (o) => { creates.push(o); return created({ enabled: true, results: { first: u8(40, 41).buffer } }); }, get: async (o) => { gets.push(o); } } };
  const api = fakeApi({ 'passkey/options': registerOptions(), 'passkey/register': { added: { id: ID1 } } });
  let confirmed = false;
  const out = await withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'Mac' }, async () => { confirmed = true; }));
  assert.deepStrictEqual(out, { added: { id: ID1 } });
  assert.strictEqual(confirmed, false); assert.strictEqual(gets.length, 0);
  assert.deepStrictEqual(api.calls[0], ['passkey/options', { purpose: 'register', passphrase: 'pw' }]);
  const pk = creates[0].publicKey;
  assert.deepStrictEqual(Array.from(pk.challenge), [8, 8]);
  assert.deepStrictEqual(pk.rp, { id: 'hub.example.ts.net', name: 'My Maestro' });
  assert.deepStrictEqual([pk.user.name, pk.user.displayName, Array.from(pk.user.id)], ['owner', 'owner', [5, 5]]);
  assert.strictEqual(pk.pubKeyCredParams.length, 3); assert.strictEqual(pk.attestation, 'none');
  assert.strictEqual(pk.authenticatorSelection.userVerification, 'required'); assert.strictEqual(pk.timeout, 120000);
  assert.deepStrictEqual(pk.excludeCredentials.map(c => [c.type, Array.from(c.id)]), [['public-key', [4, 5, 6]]]);
  assert.deepStrictEqual(Array.from(pk.extensions.prf.eval.first), [10, 11]);
  assert.deepStrictEqual(api.calls[1], ['passkey/register', {
    passphrase: 'pw', label: 'Mac', challenge: b64(8, 8),
    credential: { id: ID1, clientDataJSON: b64(20), authenticatorData: b64(21), publicKey: b64(30, 31), publicKeyAlgorithm: -7 },
    prf: b64(40, 41),
  }]);
  assert.strictEqual('confirm' in api.calls[1][1], false);
});

test('pkAdd: no PRF result at create: the confirm step is awaited, then confirm options and a get; confirm is sent', async () => {
  const order = [], gets = [];
  const nav = { credentials: {
    create: async () => { order.push('create'); return created({ enabled: true }); },
    get: async (o) => { order.push('get'); gets.push(o); return assertion(u8(50, 51).buffer); },
  } };
  const api = fakeApi({
    'passkey/options': (b) => { order.push(`options:${b.purpose}`); return b.purpose === 'register' ? registerOptions() : { challenge: b64(6, 6), rpId: 'hub.example.ts.net', timeout: 120000, userVerification: 'required', prfSalt: SALT2 }; },
    'passkey/register': (b) => { order.push('register'); return { added: {} }; },
  });
  await withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'iPhone' }, () => new Promise((resolve) => { order.push('confirm-shown'); setTimeout(() => { order.push('confirm-tapped'); resolve(); }, 5); })));
  assert.deepStrictEqual(order, ['options:register', 'create', 'confirm-shown', 'confirm-tapped', 'options:confirm', 'get', 'register']);
  assert.deepStrictEqual(api.calls[1], ['passkey/options', { purpose: 'confirm', registerChallenge: b64(8, 8) }]);
  const pk = gets[0].publicKey;
  assert.deepStrictEqual(Array.from(pk.challenge), [6, 6]);
  assert.strictEqual(pk.rpId, 'hub.example.ts.net'); assert.strictEqual(pk.userVerification, 'required');
  assert.deepStrictEqual(pk.allowCredentials.map(c => [c.type, Array.from(new Uint8Array(c.id))]), [['public-key', [1, 2, 3]]], 'the new credential, by its raw id');
  assert.deepStrictEqual(Array.from(pk.extensions.prf.eval.first), [12, 13]);
  const sent = api.calls[2][1];
  assert.strictEqual(sent.prf, b64(50, 51));
  assert.deepStrictEqual(sent.confirm, { challenge: b64(6, 6), clientDataJSON: b64(1), authenticatorData: b64(2), signature: b64(3) });
});

test('pkAdd: no PRF result even after the confirm tap is refused, and nothing is registered', async () => {
  const nav = { credentials: { create: async () => created(undefined), get: async () => assertion(null) } };
  const api = fakeApi({
    'passkey/options': (b) => (b.purpose === 'register' ? registerOptions() : { challenge: b64(6), rpId: 'x', timeout: 1, prfSalt: SALT2 }),
    'passkey/register': {},
  });
  await assert.rejects(withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'x' }, async () => {})),
    { message: "This device didn't give the unlock secret, so it can't unlock the wallet." + STRAY });
  assert.ok(!api.calls.some(c => c[0] === 'passkey/register'));
});

test('pkAdd: prf.enabled === false is refused before any register call', async () => {
  const nav = { credentials: { create: async () => created({ enabled: false }) } };
  const api = fakeApi({ 'passkey/options': registerOptions(), 'passkey/register': {} });
  await assert.rejects(withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'x' }, async () => {})),
    { message: "This device's passkeys can't unlock the wallet. Keep using the passphrase here." + STRAY });
  assert.deepStrictEqual(api.calls.map(c => c[0]), ['passkey/options']);
});

test('pkAdd: a missing getPublicKey() is refused before any register call', async () => {
  const nav = { credentials: { create: async () => created({ enabled: true, results: { first: u8(1).buffer } }, null) } };
  const api = fakeApi({ 'passkey/options': registerOptions(), 'passkey/register': {} });
  await assert.rejects(withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'x' }, async () => {})),
    { message: "This device's passkey type isn't supported here." });
  assert.deepStrictEqual(api.calls.map(c => c[0]), ['passkey/options']);
});

test('pkAdd: an error from the hub (wrong passphrase) stops before the device is asked', async () => {
  let asked = false;
  const nav = { credentials: { create: async () => { asked = true; } } };
  const api = async () => { throw new Error('Wrong passphrase.'); };
  await assert.rejects(withNavigator(nav, () => pkAdd(api, { passphrase: 'bad', label: 'x' }, async () => {})), { message: 'Wrong passphrase.' });
  assert.strictEqual(asked, false);
});

test('the desktop Wallet panel: unlock button, passkey box, deep link', () => {
  const app = read('app.js');
  const panel = block(app, 'async function openWalletPanel(', '\n    }\n    let walletFw');
  // the unlock button: only while locked, on a usable address with a passkey for this host, above the passphrase field
  assert.match(panel, /const pkHere = pkOk\.ok && pkList\.some\(p => p\.rpId === location\.hostname\);/);
  const unlock = block(panel, 'const unlockBox =', 'const pkRows');
  assert.ok(unlock.indexOf('Unlock with Face ID / fingerprint') > 0 && unlock.indexOf('Unlock with Face ID / fingerprint') < unlock.indexOf('id="w-pass"'), 'button above the passphrase field');
  assert.match(unlock, /\$\{pkHere \? `/);
  // the box: right after the Unlock box; labels and addresses escaped; remove by id; the add form or the reason
  assert.match(panel, /\$\{unlockBox\}\$\{passkeyBox\}\$\{revealOut\}/);
  const box = block(panel, 'const pkRows', 'let html =');
  assert.ok(box.includes(WORDING), 'the new sentence under the heading');
  assert.match(box, /<strong>\$\{esc\(p\.label\)\}<\/strong>/);
  assert.match(box, /\$\{esc\(p\.rpId\)\}/);
  // esc() leaves quotes alone: everything inside an attribute uses the attribute-safe helper; no label in an attribute
  assert.match(box, /data-pk-id="\$\{escAttr\(p\.id\)\}" onclick="walletAct\('pkremove', this\.dataset\.pkId\)"/);
  assert.ok(!/data-pk-label/.test(box), 'the label is not carried in an attribute');
  assert.match(box, /id="pk-label" value="\$\{escAttr\(pkDeviceLabel\(\)\)\}"/);
  assert.ok(!/(?:data-[a-z-]+|value|title|placeholder)="\$\{esc\(/.test(box), 'no esc() inside an attribute in the passkey box');
  assert.match(box, /id="pk-pass" type="password" autocomplete="off"/);
  assert.match(box, /\$\{esc\(pkOk\.text\)\}/, 'the reason instead of the form');
  assert.match(box, /<input type="checkbox" id="pk-notice" \$\{s\.lockedNotice \? 'checked' : ''\} onchange="walletLockedNotice\(this\)"> Send admins a phone notice when the wallet is locked after a restart/);
  // the actions
  const act = block(app, 'async function walletPasskeyAct(', '\n    async function walletAct(');
  assert.ok(act.includes(REMOVE_CONFIRM_JS), 'the new remove confirm');
  assert.match(act, /walletPkList\.find\(p => p\.id === id\)/, 'the label is looked up by id');
  assert.match(act, /await walletApi\('passkey\/remove', \{ id \}, run\.ctrl\.signal\); done = 'Removed\.'/);
  assert.match(act, /await pkUnlock\(\(p, b\) => walletApi\(p, b, run\.ctrl\.signal\), run\.ctrl\.signal\); done = 'Unlocked until the hub restarts\.'/);
  assert.match(act, /await pkAdd\(\(p, b\) => walletApi\(p, b, run\.ctrl\.signal\), \{ passphrase, label: name \}, confirmStep, run\.ctrl\.signal\);/);
  assert.match(act, /await walletApi\('unlock', \{ passphrase \}, run\.ctrl\.signal\)/, 'the passphrase unlock is a run too');
  assert.match(act, /const run = pkRunStart\(/);
  assert.match(act, /if \(!run\) return;/);
  assert.match(act, /if \(!pkRunEnd\(run\)\) return;[^\n]*\n\s*await openWalletPanel\(done, \{\}, \{ refresh: true \}\);/, 'repaint only after the run has ended, and never reopening a closed panel');
  assert.match(act, /catch \(e\) \{\s*passphrase = '';\s*if \(!pkRunEnd\(run\)\) return;\s*alert\(pkErrorText\(e\)\);/);
  assert.ok(!/finally/.test(act) && !/pkCurrent/.test(app), 'no finally, no round-2 pkCurrent');
  assert.ok(act.indexOf('confirm(') < act.indexOf('pkRunStart('), 'the Remove confirm() comes before the run starts');
  assert.match(act, /if \(run\.cancelled \|\| run\.ctrl\.signal\.aborted\) return reject\(new DOMException\('Cancelled\.', 'AbortError'\)\)/);
  assert.match(act, /run\.rejectConfirm = reject;/);
  assert.match(panel, /pkCancel\(\);\s*\/\/[^\n]*\n\s*gsModal\(html, dock\);/, 'a redraw cancels the running prompt right before it replaces the panel');
  assert.match(act, /done = `Added\. \$\{name\} can now unlock the wallet\.`/);
  assert.ok(act.indexOf("passEl.value = ''") > 0 && act.indexOf("passEl.value = ''") < act.indexOf('await pkAdd('), 'the passphrase field is emptied before the request');
  assert.match(act, /Confirm with Face ID \/ fingerprint/);
  assert.match(act, /alert\(pkErrorText\(e\)\)/);
  assert.match(app, /async function walletApi\(path, body, signal\) \{[\s\S]*?signal \}[\s\S]*?signal \}\);/, 'walletApi hands the signal to fetch');
  const runs = block(app, 'let pkRun = null', '// esc() leaves quotes alone');
  assert.match(runs, /document\.querySelectorAll\('#pk-box button, #pk-unlock-btn'\)\.forEach\(b => \{ b\.disabled = true; \}\)/, 'buttons disabled while a run goes');
  assert.match(runs, /new MutationObserver\(\(\) => \{ if \(!overlay\.isConnected\) pkCancel\(\); \}\)/, 'the panel leaving the page cancels');
  assert.match(runs, /function pkRunStart\(confirmRow, fields\) \{\s*if \(pkRun\) return null;/);
  assert.match(runs, /function pkRunEnd\(run\) \{\s*if \(pkRun !== run\) return false;/);
  assert.ok(!/pkCancel/.test(block(app, 'async function walletAct(', 'if (action === \'lock\')')), 'walletAct itself does not cancel');
  assert.match(app, /if \(action === 'pkunlock' \|\| action === 'pkadd' \|\| action === 'pkremove'\) return walletPasskeyAct\(action, arg, arg2\);/, 'every trigger goes through the one action function');
  assert.match(app, /return walletPasskeyAct\('unlock'\);/, 'and so does the passphrase unlock');
  assert.match(panel, /id="w-pass"[^\n]*walletAct\('unlock'\)/, 'Enter in the unlock field goes through walletAct');
  assert.match(box, /id="pk-pass"[^\n]*walletAct\('pkadd'\)/, 'Enter in the add field goes through walletAct');
  assert.match(block(app, 'async function walletLockedNotice(', '\n    async function walletAct('), /JSON\.stringify\(\{ walletLockedNotice: on \}\)/);
});

test('the phone Wallet sheet: admin-only menu item, passkey buttons, deep link', () => {
  const mob = read('mobile.js'), html = read('mobile.html');
  // the menu item: hidden in the page, shown only to admins
  assert.match(html, /<button id="menu-wallet" hidden>[^<]*Wallet<\/button>/);
  assert.match(mob, /if \(\$\('menu-wallet'\)\) \$\('menu-wallet'\)\.hidden = !hubMe\.isAdmin;/);
  assert.match(mob, /\$\('menu-wallet'\)\?\.addEventListener\('click', openWalletSheet\);/);
  assert.match(block(mob, 'function openWalletSheet(', 'async function walletLoad('), /if \(!isAdmin\(\)\) return;/);
  // the sheet: the page's full-screen sheet frame and the dialog guard (Back closes it)
  const sheet = block(mob, 'function walletSheet(', 'function openWalletSheet(');
  assert.match(sheet, /className = 'rsn-sheet mh-sheet wallet-sheet'/);
  assert.match(block(mob, 'function openWalletSheet(', 'async function walletLoad('), /dialogGuard\.open\(sh, \{ close: sh\.closeSheet \}\)/);
  assert.match(block(mob, 'function walletClose(', 'function walletSheet('), /dialogGuard\.closed\(sh\)/);
  // the content: status, unlock, passkeys, notice; labels and addresses escaped
  const paint = block(mob, 'function walletPaint(', 'function walletSetBusy(');
  assert.match(paint, /No wallet is set up on this hub\./);
  assert.match(paint, /const pkHere = pkOk\.ok && pkList\.some\(p => p\.rpId === location\.hostname\);/);
  assert.ok(paint.indexOf('Unlock with Face ID / fingerprint') > 0 && paint.indexOf('Unlock with Face ID / fingerprint') < paint.indexOf('id="wl-pass"'), 'passkey button above the passphrase field');
  assert.match(paint, /id="wl-pass" type="password" autocomplete="off"/);
  assert.match(paint, /Unlock with passphrase/);
  assert.match(paint, /<strong>\$\{esc\(p\.label\)\}<\/strong>/);
  assert.match(paint, /\$\{esc\(p\.rpId\)\}/);
  assert.match(paint, /data-id="\$\{esc\(p\.id\)\}">Remove/);
  assert.ok(!/data-label/.test(paint) && !/dataset\.label/.test(mob.slice(mob.indexOf('function walletSheet('))), 'the label is looked up by id, not carried in an attribute');
  assert.match(paint, /id="wl-pk-label" value="\$\{esc\(pkDeviceLabel\(\)\)\}"/);
  assert.match(paint, /id="wl-pk-pass" type="password" autocomplete="off"/);
  assert.match(paint, /\$\{esc\(pkOk\.text\)\}/, 'the reason instead of the form');
  assert.match(paint, /<input type="checkbox" id="wl-notice" \$\{s\.lockedNotice \? 'checked' : ''\}> Send admins a phone notice when the wallet is locked after a restart/);
  assert.ok(paint.includes(WORDING), 'the new sentence under the heading');
  // the actions
  const act = block(mob, 'async function walletAct(', '// The after-restart notice');
  assert.ok(act.includes(REMOVE_CONFIRM_JS), 'the new remove confirm');
  assert.match(act, /\.passkeys\) \|\| \[\]\)\.find\(p => p\.id === id\)/, 'the label is looked up by id');
  assert.match(act, /walletApi\('passkey\/remove', \{ id \}, run\.ctrl\.signal\)/);
  assert.match(act, /await pkUnlock\(\(p, b\) => walletApi\(p, b, run\.ctrl\.signal\), run\.ctrl\.signal\)/);
  assert.match(act, /await pkAdd\(\(p, b\) => walletApi\(p, b, run\.ctrl\.signal\), \{ passphrase, label: name \}, confirmStep, run\.ctrl\.signal\);/);
  assert.match(act, /const run = pkRunStart\(/);
  assert.match(act, /if \(!run\) return;/);
  assert.match(act, /if \(!pkRunEnd\(run\)\) return;[^\n]*\n\s*await walletLoad\(\{ text: done, ok: true \}\);/, 'repaint only after the run has ended');
  assert.match(act, /catch \(e\) \{\s*passphrase = '';\s*if \(!pkRunEnd\(run\)\) return;\s*const text = pkErrorText\(e\);\s*walletShowMsg\(text, false\);\s*walletLoad\(\{ text, ok: false \}\);/);
  assert.ok(!/finally/.test(act) && !/pkCurrent/.test(mob), 'no finally, no round-2 pkCurrent');
  assert.ok(act.indexOf('confirm(') < act.indexOf('pkRunStart('), 'the Remove confirm() comes before the run starts');
  assert.match(act, /if \(run\.cancelled \|\| run\.ctrl\.signal\.aborted\) return reject\(new DOMException\('Cancelled\.', 'AbortError'\)\)/);
  assert.match(block(mob, 'function walletClose(', 'function walletSheet('), /pkCancel\(\); walletGen\+\+;[\s\S]*input\[type="password"\][\s\S]*i\.value = ''/, 'closing the sheet cancels, bumps the generation and empties the passwords');
  assert.match(sheet, /const close = \(\) => walletClose\(sh\);/);
  assert.match(block(mob, 'function openWalletSheet(', 'async function walletLoad('), /walletStatus = null;[^\n]*\n\s*walletPaint\(\);\s*walletLoad\(\);/, 'opening paints Loading before the load');
  assert.ok(!/pkCancel/.test(paint), 'a repaint cancels nothing');
  const load = block(mob, 'async function walletLoad(', 'function walletPaint(');
  assert.match(load, /const gen = \+\+walletGen;/);
  assert.match(load, /gen !== walletGen \|\| !sh \|\| !sh\.classList\.contains\('open'\) \|\| pkRun/, 'a stale load paints nothing');
  assert.match(mob, /async function walletApi\(path, body, signal\) \{[\s\S]*?signal \}[\s\S]*?signal \}\);/, 'walletApi hands the signal to fetch');
  assert.match(block(mob, 'function pkRunStart(', 'function pkRunCleanup('), /walletSetBusy\(true\);\s*walletGen\+\+;/);
  assert.match(mob, /function pkRunEnd\(run\) \{\s*if \(pkRun !== run\) return false;/);
  assert.match(sheet, /e\.target\.id === 'wl-pass'\) \{ e\.preventDefault\(\); walletAct\('unlock'\)/, 'Enter goes through walletAct');
  assert.match(sheet, /e\.target\.id === 'wl-pk-pass'\) \{ e\.preventDefault\(\); walletAct\('pkadd'\)/);
  assert.match(act, /await walletApi\('unlock', \{ passphrase \}, run\.ctrl\.signal\)/);
  assert.ok(act.indexOf("passEl.value = ''") > 0 && act.indexOf("passEl.value = ''") < act.indexOf("await walletApi('unlock'"), 'the passphrase field is emptied before the request');
  assert.ok(act.indexOf("passEl.value = ''") < act.indexOf('await pkAdd('), 'and before the passkey request');
  assert.match(act, /Confirm with Face ID \/ fingerprint/);
  assert.match(act, /const text = pkErrorText\(e\);\s*walletShowMsg\(text, false\)/);
  assert.ok(!/alert\(/.test(act), 'results are a line in the sheet, not alert()');
  assert.match(block(mob, 'function walletSetBusy(', 'function walletShowMsg('), /el\.disabled = on/, 'buttons disabled while a request runs');
  assert.match(mob, /async function walletApi\(path, body, signal\) \{[\s\S]*?throw new Error\(j\.error \|\| 'Request failed'\)/);
  const notice = block(mob, 'async function walletLockedNotice(', '// ── Restart the hub');
  assert.match(notice, /JSON\.stringify\(\{ walletLockedNotice: on \}\)/);
  assert.match(notice, /box\.checked = !on/);
  // the deep link: parsed, acted on once, stripped from the address
  const init = block(mob, "get('wallet') === 'unlock'", 'openWalletSheet();');
  assert.match(init, /searchParams\.delete\('wallet'\)/);
  assert.match(init, /history\.replaceState\(/);
});

test('the service worker maps the phone notice /mobile?wallet=unlock to the desktop /?wallet=unlock', () => {
  assert.match(read('sw.js'), /if \(u\.searchParams\.get\('wallet'\) === 'unlock'\) return '\/\?wallet=unlock';/);
});

test('pkUnlock and pkAdd hand the AbortSignal to every WebAuthn call', async () => {
  const ctrl = new AbortController();
  const seen = [];
  const nav = { credentials: {
    get: async (o) => { seen.push(['get', o.signal]); return assertion(u8(7).buffer); },
    create: async (o) => { seen.push(['create', o.signal]); return created({ enabled: true, results: { first: u8(40).buffer } }); },
  } };
  const api = fakeApi({
    'passkey/options': (b) => (b.purpose === 'unlock' ? unlockOptions([ID1]) : registerOptions()),
    'passkey/unlock': {}, 'passkey/register': {},
  });
  await withNavigator(nav, () => pkUnlock(api, ctrl.signal));
  await withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'x' }, async () => {}, ctrl.signal));
  assert.deepStrictEqual(seen.map(s => s[0]), ['get', 'create']);
  assert.ok(seen.every(s => s[1] === ctrl.signal), 'the same signal everywhere');
  // the confirm-step get carries it too
  seen.length = 0;
  const nav2 = { credentials: {
    get: async (o) => { seen.push(['get', o.signal]); return assertion(u8(7).buffer); },
    create: async (o) => { seen.push(['create', o.signal]); return created({ enabled: true }); },
  } };
  const api2 = fakeApi({
    'passkey/options': (b) => (b.purpose === 'register' ? registerOptions() : { challenge: b64(6), rpId: 'x', timeout: 1, prfSalt: SALT2 }),
    'passkey/register': {},
  });
  await withNavigator(nav2, () => pkAdd(api2, { passphrase: 'pw', label: 'x' }, async () => {}, ctrl.signal));
  assert.deepStrictEqual(seen.map(s => s[0]), ['create', 'get']);
  assert.ok(seen.every(s => s[1] === ctrl.signal));
  seen.length = 0;
  await withNavigator(nav, () => pkUnlock(api));
  assert.strictEqual(seen[0][1], undefined, 'no signal is fine');
});

test('pkAdd: a confirm step that rejects ends the add and sends nothing more', async () => {
  const nav = { credentials: { create: async () => created({ enabled: true }), get: async () => { throw new Error('asked again'); } } };
  const api = fakeApi({ 'passkey/options': registerOptions(), 'passkey/register': {} });
  const cancel = new DOMException('Cancelled.', 'AbortError');
  await assert.rejects(withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'x' }, () => Promise.reject(cancel))), (e) => e === cancel);
  assert.deepStrictEqual(api.calls.map(c => c[0]), ['passkey/options'], 'no confirm options, no register');
});

test('a passkey label with quotes and tags never reaches an attribute raw (desktop and phone)', () => {
  const evil = `a" b='c <i>`;
  const list = [{ id: 'id"1', label: evil, rpId: 'hub.example.ts.net', createdAt: 1 }];
  // desktop: the page's escAttr and its row template, evaluated with a stand-in esc()
  const app = read('app.js');
  const escAttrSrc = block(app, 'const escAttr = ', '\n').trim();
  const rowSrc = block(app, 'pkList.map(p => `', ".join('')");
  const esc = (s) => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const dHtml = new Function('esc', 'pkList', `${escAttrSrc}\nreturn ${rowSrc}.join('');`)(esc, list);
  const attrs = [...dHtml.matchAll(/="([^"]*)"/g)].map(m => m[1]).join('|');
  assert.ok(!attrs.includes(evil) && !attrs.includes("'c") && !/[<>]/.test(attrs), attrs);
  assert.ok(!dHtml.includes('data-pk-label'), 'no label attribute at all');
  assert.ok(dHtml.includes('data-pk-id="id&quot;1"'), dHtml);
  // phone: the label is looked up by id and its esc() escapes quotes
  const mob = read('mobile.js');
  const mobRow = block(mob, 'const rows = pkList.map(p => `', 'Remove</button>');
  assert.ok(!/data-label/.test(mobRow) && /data-id="\$\{esc\(p\.id\)\}"/.test(mobRow));
  const mobEsc = block(mob, 'function esc(s) {', '\n}\n');
  assert.ok(mobEsc.includes('&quot;') && mobEsc.includes('&#39;'), 'the phone esc() escapes quotes');
});

// ── Round 3: one run at a time; a cancelled run leaves no trace ──
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setImmediate(r));

test('pkAdd aborted while the register-options request is pending: AbortError, no create(), no further api call', async () => {
  const ctrl = new AbortController(), pending = deferred();
  let createCount = 0;
  const nav = { credentials: { create: async () => { createCount++; return created({ enabled: true }); }, get: async () => { throw new Error('get'); } } };
  const calls = [];
  const api = async (p) => { calls.push(p); return pending.promise; };
  const run = withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'x' }, async () => {}, ctrl.signal));
  await tick(); ctrl.abort(); pending.resolve(registerOptions());
  await assert.rejects(run, { name: 'AbortError' });
  assert.strictEqual(createCount, 0); assert.deepStrictEqual(calls, ['passkey/options']);
});

test('pkAdd aborted after the confirm tap while the confirm-options request is pending: no get(), no register', async () => {
  const ctrl = new AbortController(), pending = deferred();
  const log = [];
  const nav = { credentials: { create: async () => created({ enabled: true }), get: async () => { log.push('get'); return assertion(u8(1).buffer); } } };
  const api = async (p, b) => { log.push(p + ':' + (b.purpose || '')); return b.purpose === 'register' ? registerOptions() : pending.promise; };
  const run = withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'x' }, async () => { log.push('confirmed'); }, ctrl.signal));
  await tick();
  assert.deepStrictEqual(log, ['passkey/options:register', 'confirmed', 'passkey/options:confirm']);
  ctrl.abort(); pending.resolve({ challenge: b64(6), rpId: 'x', timeout: 1, prfSalt: SALT2 });
  await assert.rejects(run, { name: 'AbortError' });
  assert.deepStrictEqual(log, ['passkey/options:register', 'confirmed', 'passkey/options:confirm'], 'no get, no register POST');
});

test('pkUnlock aborted while its options request is pending: no get(), no unlock POST', async () => {
  const ctrl = new AbortController(), pending = deferred();
  const log = [];
  const nav = { credentials: { get: async () => { log.push('get'); return assertion(u8(1).buffer); } } };
  const api = async (p) => { log.push(p); return pending.promise; };
  const run = withNavigator(nav, () => pkUnlock(api, ctrl.signal));
  await tick(); ctrl.abort(); pending.resolve(unlockOptions([ID1]));
  await assert.rejects(run, { name: 'AbortError' });
  assert.deepStrictEqual(log, ['passkey/options']);
});

// A DOM-free simulation of the phone's walletAct ordering: the page's own run code and walletAct are cut out of
// mobile.js and run with stand-ins for the sheet, walletApi, pkAdd and pkUnlock.
function phoneSim(enrollMs) {
  const mob = read('mobile.js');
  let runCode = block(mob, 'let pkRun = null;', 'async function walletApi(');
  if (enrollMs !== undefined) {
    assert.ok(runCode.includes('const PK_ENROLL_MS = 110000;'), 'the deadline is a named constant');
    runCode = runCode.replace('const PK_ENROLL_MS = 110000;', `const PK_ENROLL_MS = ${enrollMs};`);
  }
  const closeCode = block(mob, 'function walletClose(', 'function walletSheet(');
  const actCode = block(mob, 'async function walletAct(', '// The after-restart notice');
  const el = (value = '') => ({ value, innerHTML: '', isConnected: true, focus() {} });
  const btn = {};
  const confirmRow = { innerHTML: '', isConnected: true, querySelector: () => btn };
  const fields = { '#wl-pass': el(), '#wl-pk-pass': el(), '#wl-pk-label': el('Phone'), '#wl-confirm-row': confirmRow };
  const classes = new Set(['open']);
  const sh = {
    querySelector: (q) => fields[q] || null,
    querySelectorAll: (q) => (q === 'input[type="password"]' ? [fields['#wl-pass'], fields['#wl-pk-pass']] : []),
    classList: { remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
  const env = { busy: false, loads: [], msgs: [], add: null, unlock: null, apiCalls: [], sh, DOMException, AbortController, api: async () => ({}) };
  const factory = new Function('S', `
    const $ = () => S.sh, confirm = () => true;
    const walletStatus = { keystore: { passkeys: [] } };
    const pkErrorText = (e) => e.message || e.name, pkDeviceLabel = () => 'Phone';
    const walletSetBusy = (on) => { S.busy = on; };
    const walletShowMsg = (t, ok) => { S.msgs.push([t, ok]); };
    const walletLoad = async (m) => { S.loads.push(m); };
    const walletApi = (p, b, signal) => { S.apiCalls.push([p, b, signal]); return S.api(p, b, signal); };
    const pkAdd = (...a) => S.add(...a), pkUnlock = (...a) => S.unlock(...a);
    const dialogGuard = { closed: () => { S.closedGuard = true; } };
    ${runCode}
    ${closeCode}
    ${actCode}
    return { walletAct, walletClose, pkCancel, state: () => ({ run: pkRun, gen: walletGen }) };
  `);
  return { env, page: factory(env), fields, confirmRow, sh };
}

test('phone walletAct: start an add, reach the confirm, close: busy is off at once and a passphrase unlock can start', async () => {
  const { env, page, fields, confirmRow } = phoneSim();
  env.add = async (api, o, confirmStep) => { await confirmStep(); await new Promise(() => {}); };
  fields['#wl-pk-pass'].value = 'secret';
  const addRun = page.walletAct('pkadd');
  await tick();
  assert.strictEqual(env.busy, true); assert.ok(confirmRow.innerHTML.includes('Confirm with Face ID'), 'confirm row drawn');
  assert.strictEqual(fields['#wl-pk-pass'].value, '', 'passphrase emptied before the request');
  const first = page.state().gen;
  page.pkCancel();   // closing the sheet
  assert.strictEqual(env.busy, false, 'busy off at once'); assert.strictEqual(confirmRow.innerHTML, ''); assert.strictEqual(page.state().run, null);
  const second = deferred(); env.api = () => second.promise;
  fields['#wl-pass'].value = 'pw';
  const unlockRun = page.walletAct('unlock');
  await tick();
  assert.strictEqual(env.busy, true, 'the passphrase unlock started');
  assert.deepStrictEqual(env.apiCalls.map(c => c[0]), ['unlock']);
  assert.ok(page.state().gen > first, 'starting a run bumps the generation');
  second.resolve({}); await unlockRun; await addRun;
  assert.deepStrictEqual(env.loads, [{ text: 'Unlocked until the hub restarts.', ok: true }]);
  assert.deepStrictEqual(env.msgs, [], 'the cancelled add said nothing');
  assert.strictEqual(env.busy, false);
});

test("phone walletAct: A cancelled, B started, then A settles: B's confirm row and busy state are untouched", async () => {
  for (const settle of ['resolve', 'reject']) {
    const { env, page, fields, confirmRow } = phoneSim();
    const aPending = deferred();
    env.unlock = () => aPending.promise;
    const A = page.walletAct('pkunlock');
    await tick();
    assert.strictEqual(env.busy, true);
    page.pkCancel();
    env.add = async (api, o, confirmStep) => { await confirmStep(); await new Promise(() => {}); };
    fields['#wl-pk-pass'].value = 'secret';
    page.walletAct('pkadd');
    await tick();
    assert.ok(confirmRow.innerHTML.includes('Confirm with Face ID')); assert.strictEqual(env.busy, true);
    const rowBefore = confirmRow.innerHTML;
    aPending[settle](settle === 'resolve' ? {} : new Error('late failure'));
    await A; await tick();
    assert.strictEqual(confirmRow.innerHTML, rowBefore, `B's confirm row stays (${settle})`);
    assert.strictEqual(env.busy, true, `B stays busy (${settle})`);
    assert.deepStrictEqual(env.loads, []); assert.deepStrictEqual(env.msgs, []);
    assert.ok(page.state().run, 'B is still the run');
  }
});

test('phone walletAct: a second tap while a run is going is ignored', async () => {
  const { env, page, fields } = phoneSim();
  const pending = deferred(); env.api = () => pending.promise;
  fields['#wl-pass'].value = 'pw';
  const first = page.walletAct('unlock'); await tick();
  fields['#wl-pass'].value = 'other';
  await page.walletAct('unlock');
  assert.strictEqual(env.apiCalls.length, 1); assert.strictEqual(fields['#wl-pass'].value, 'other', 'the ignored tap touched nothing');
  pending.resolve({}); await first;
});

// ── Round 4: stale panel loads, passphrases, the enrollment deadline, the phone's stale view ──
test('phone: closing the sheet empties both password fields, with no run going', () => {
  const { env, page, fields, sh } = phoneSim();
  fields['#wl-pass'].value = 'typed'; fields['#wl-pk-pass'].value = 'typed too';
  assert.strictEqual(page.state().run, null);
  const before = page.state().gen;
  page.walletClose(sh);
  assert.strictEqual(fields['#wl-pass'].value, ''); assert.strictEqual(fields['#wl-pk-pass'].value, '');
  assert.ok(page.state().gen > before, 'closing drops loads in flight');
  assert.strictEqual(sh.classList.contains('open'), false); assert.strictEqual(env.closedGuard, true);
});

test('phone: the deadline cancels an add stuck at the confirm button and frees the page', async () => {
  const { env, page, fields, confirmRow } = phoneSim(15);
  env.add = async (api, o, confirmStep) => { await confirmStep(); await new Promise(() => {}); };
  fields['#wl-pk-pass'].value = 'secret';
  const addRun = page.walletAct('pkadd');
  await tick();
  assert.strictEqual(env.busy, true); assert.ok(confirmRow.innerHTML.includes('Confirm with Face ID'));
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(env.busy, false, 'busy off'); assert.strictEqual(confirmRow.innerHTML, ''); assert.strictEqual(page.state().run, null);
  assert.deepStrictEqual(env.msgs, [['Setup timed out. Start again.', false]]);
  assert.deepStrictEqual(env.loads, [{ text: 'Setup timed out. Start again.', ok: false }]);
  const pending = deferred(); env.api = () => pending.promise;
  fields['#wl-pass'].value = 'pw';
  const unlockRun = page.walletAct('unlock'); await tick();
  assert.deepStrictEqual(env.apiCalls.map(c => c[0]), ['unlock'], 'a passphrase unlock can start');
  pending.resolve({}); await unlockRun;
  void addRun;
});

test('phone: a finished run clears its timer, so the deadline never fires later', async () => {
  const { env, page, fields } = phoneSim(15);
  env.add = async () => {};
  fields['#wl-pk-pass'].value = 'secret';
  await page.walletAct('pkadd');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(env.msgs, []); assert.strictEqual(env.loads.length, 1, 'only the success load');
});

test('phone: a run ending in failure or an empty passphrase starts a new load that keeps the message', async () => {
  const { env, page } = phoneSim();
  env.unlock = async () => { throw new Error('Boom.'); };
  await page.walletAct('pkunlock');
  assert.deepStrictEqual(env.msgs, [['Boom.', false]]);
  assert.deepStrictEqual(env.loads, [{ text: 'Boom.', ok: false }]);
  await page.walletAct('unlock');   // the passphrase field is empty
  assert.deepStrictEqual(env.msgs[1], ['Type the wallet passphrase first.', false]);
  assert.deepStrictEqual(env.loads[1], { text: 'Type the wallet passphrase first.', ok: false });
  assert.strictEqual(env.busy, false); assert.strictEqual(page.state().run, null);
  // a cancelled run starts no load
  const A = deferred(); env.unlock = () => A.promise;
  const run = page.walletAct('pkunlock'); await tick(); page.pkCancel(); A.reject(new Error('late')); await run;
  assert.strictEqual(env.loads.length, 2);
});

test('the phone sheet: the deadline is a named 110 s constant, cleared with the run', () => {
  const mob = read('mobile.js');
  assert.match(mob, /const PK_ENROLL_MS = 110000;/);
  assert.match(mob, /run\.timer = setTimeout\([\s\S]*?\}, PK_ENROLL_MS\);/);
  assert.match(block(mob, 'function pkRunCleanup(', 'function pkCancel('), /clearTimeout\(run\.timer\)/);
  const act = block(mob, 'async function walletAct(', '// The after-restart notice');
  assert.match(act, /passphrase = '';[^\n]*\n\s*if \(!pkRunEnd\(run\)\) return;/, 'cleared before the run ends');
  assert.match(act, /Setup timed out\. Start again\./);
});

test('the desktop Wallet panel: stale loads draw nothing, a refresh never reopens a closed panel, other actions wait', () => {
  const app = read('app.js');
  const panel = block(app, 'async function openWalletPanel(', '\n    }\n    let walletFw');
  assert.match(app, /let pkRun = null, walletPkList = \[\], walletPanelGen = 0;/);
  assert.match(panel, /const gen = \+\+walletPanelGen;/);
  // every await in the panel is followed by the generation check before anything is assigned or drawn
  const lines = panel.split('\n');
  let awaits = 0;
  lines.forEach((l, i) => {
    if (!/await walletApi\(/.test(l)) return;
    awaits++;
    assert.match(lines[i + 1], /gen !== walletPanelGen\) return;/, `a check right after: ${l.trim().slice(0, 50)}`);
  });
  assert.strictEqual(awaits, 4, 'status, executor, hl, allowlist');
  assert.ok(panel.indexOf('gen !== walletPanelGen') < panel.indexOf('walletPkList = '), 'checked before the list is assigned');
  assert.ok(panel.indexOf('gen !== walletPanelGen') < panel.indexOf('pkCancel();'), 'checked before pkCancel');
  assert.match(panel, /if \(err\) \{ pkCancel\(\); return gsModal/, 'the error path draws only after the check');
  assert.match(block(app, 'function pkRunStart(', 'function pkRunCleanup('), /walletPanelGen\+\+;/);
  // the refresh flag: return without drawing when the panel is gone
  assert.match(panel, /opts\.refresh && panelGone\(\)\) return;/);
  assert.match(panel, /const panelGone = \(\) => \{[^\n]*ov\.isConnected[^\n]*\}/);
  assert.match(app, /await openWalletPanel\(done, \{\}, \{ refresh: true \}\);/);
  // other walletAct actions wait for a run
  assert.match(block(app, 'async function walletAct(', "if (action === 'init')"), /if \(pkRun\) return;/);
  // passphrase cleared once its request has settled, before the run ends
  const act = block(app, 'async function walletPasskeyAct(', '\n    async function walletAct(');
  assert.match(act, /passphrase = '';[^\n]*\n\s*if \(!pkRunEnd\(run\)\) return;/);
  assert.match(act, /catch \(e\) \{\s*passphrase = '';/);
  // the enrollment deadline
  assert.match(app, /const PK_ENROLL_MS = 110000;/);
  assert.match(act, /run\.timer = setTimeout\(\(\) => \{[^\n]*pkCancel\(\); alert\('Setup timed out\. Start again\.'\);[^\n]*PK_ENROLL_MS\);/);
  assert.match(block(app, 'function pkRunCleanup(', 'function pkCancel('), /clearTimeout\(run\.timer\)/);
});

test('a wallet passphrase refused with 401 does not send the desktop to the sign-in page; passkey checks answer 403', () => {
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(app.includes("|| p.startsWith('/api/wallet/');"), 'keepsOwn401 keeps wallet 401s on the page');
  const routes = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'wallet', 'passkey-routes.js'), 'utf8');
  assert.ok(!/fail\(401/.test(routes), 'passkey routes never answer 401');
  const pk = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'wallet', 'passkey.js'), 'utf8');
  assert.ok(!/, 401\)/.test(pk), 'passkey checks never answer 401');
});
