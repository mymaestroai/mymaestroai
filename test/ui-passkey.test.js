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
    assert.ok(r.text.includes('127.0.0.1') && r.text.includes('localhost') && r.text.includes('tailnet'), r.text);
    r = pkUsable(at('https:', '192.168.0.10'), win);
    assert.strictEqual(r.code, 'bad_address', 'a number is refused even over https');
    r = pkUsable(at('http:', '[::1]'), win);
    assert.strictEqual(r.code, 'bad_address'); assert.ok(r.text.includes('[::1]'));
    r = pkUsable(at('http:', 'hub.example.ts.net'), win);
    assert.strictEqual(r.code, 'bad_address'); assert.ok(r.text.includes('secure (https) address, or localhost'), r.text);
    assert.strictEqual(pkUsable(at('http:', 'localhost'), win).ok, true);
    assert.strictEqual(pkUsable(at('https:', 'localhost'), win).ok, true);
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
    { message: "This device didn't give the unlock secret, so it can't unlock the wallet." });
  assert.ok(!api.calls.some(c => c[0] === 'passkey/register'));
});

test('pkAdd: prf.enabled === false is refused before any register call', async () => {
  const nav = { credentials: { create: async () => created({ enabled: false }) } };
  const api = fakeApi({ 'passkey/options': registerOptions(), 'passkey/register': {} });
  await assert.rejects(withNavigator(nav, () => pkAdd(api, { passphrase: 'pw', label: 'x' }, async () => {})),
    { message: "This device's passkeys can't unlock the wallet. Keep using the passphrase here." });
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
  assert.match(box, /Unlock the wallet with this device's Face ID, fingerprint or screen lock instead of typing the passphrase\. Each device and each address \(this computer, the tailnet address\) is set up once with the passphrase\./);
  assert.match(box, /<strong>\$\{esc\(p\.label\)\}<\/strong>/);
  assert.match(box, /\$\{esc\(p\.rpId\)\}/);
  assert.match(box, /data-pk-id="\$\{esc\(p\.id\)\}" data-pk-label="\$\{esc\(p\.label\)\}"/);
  assert.match(box, /id="pk-label" value="\$\{esc\(pkDeviceLabel\(\)\)\}"/);
  assert.match(box, /id="pk-pass" type="password" autocomplete="off"/);
  assert.match(box, /\$\{esc\(pkOk\.text\)\}/, 'the reason instead of the form');
  assert.match(box, /<input type="checkbox" id="pk-notice" \$\{s\.lockedNotice \? 'checked' : ''\} onchange="walletLockedNotice\(this\)"> Tell my phone when the wallet is locked after a restart/);
  // the actions
  const act = block(app, 'async function walletPasskeyAct(', '\n    async function walletAct(');
  assert.match(act, /confirm\(`Remove \$\{label\}\? That device will no longer unlock the wallet\.`\)/);
  assert.match(act, /walletApi\('passkey\/remove', \{ id \}\); return openWalletPanel\('Removed\.'\)/);
  assert.match(act, /await pkUnlock\(walletApi\); return openWalletPanel\('Unlocked until the hub restarts\.'\)/);
  assert.match(act, /await pkAdd\(walletApi, \{ passphrase, label: name \}, confirmStep\);/);
  assert.match(act, /openWalletPanel\(`Added\. \$\{name\} can now unlock the wallet\.`\)/);
  assert.ok(act.indexOf("passEl.value = ''") > 0 && act.indexOf("passEl.value = ''") < act.indexOf('await pkAdd('), 'the passphrase field is emptied before the request');
  assert.match(act, /Confirm with Face ID \/ fingerprint/);
  assert.match(act, /alert\(pkErrorText\(e\)\)/);
  assert.match(act, /btns\.forEach\(b => \{ b\.disabled = on; \}\)/, 'buttons disabled while a request runs');
  assert.match(block(app, 'async function walletLockedNotice(', '\n    async function walletAct('), /JSON\.stringify\(\{ walletLockedNotice: on \}\)/);
  assert.match(app, /if \(action === 'pkunlock' \|\| action === 'pkadd' \|\| action === 'pkremove'\) return walletPasskeyAct\(action, arg, arg2\);/);
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
  assert.match(sheet, /dialogGuard\.closed\(sh\)/);
  // the content: status, unlock, passkeys, notice; labels and addresses escaped
  const paint = block(mob, 'function walletPaint(', 'function walletSetBusy(');
  assert.match(paint, /No wallet is set up on this hub\./);
  assert.match(paint, /const pkHere = pkOk\.ok && pkList\.some\(p => p\.rpId === location\.hostname\);/);
  assert.ok(paint.indexOf('Unlock with Face ID / fingerprint') > 0 && paint.indexOf('Unlock with Face ID / fingerprint') < paint.indexOf('id="wl-pass"'), 'passkey button above the passphrase field');
  assert.match(paint, /id="wl-pass" type="password" autocomplete="off"/);
  assert.match(paint, /Unlock with passphrase/);
  assert.match(paint, /<strong>\$\{esc\(p\.label\)\}<\/strong>/);
  assert.match(paint, /\$\{esc\(p\.rpId\)\}/);
  assert.match(paint, /data-id="\$\{esc\(p\.id\)\}" data-label="\$\{esc\(p\.label\)\}"/);
  assert.match(paint, /id="wl-pk-label" value="\$\{esc\(pkDeviceLabel\(\)\)\}"/);
  assert.match(paint, /id="wl-pk-pass" type="password" autocomplete="off"/);
  assert.match(paint, /\$\{esc\(pkOk\.text\)\}/, 'the reason instead of the form');
  assert.match(paint, /<input type="checkbox" id="wl-notice" \$\{s\.lockedNotice \? 'checked' : ''\}> Tell this phone when the wallet is locked after a restart/);
  assert.match(paint, /Unlock with this phone's Face ID, fingerprint or screen lock instead of the passphrase\. Set it up once with the passphrase\./);
  // the actions
  const act = block(mob, 'async function walletAct(', '// The after-restart notice');
  assert.match(act, /confirm\(`Remove \$\{label\}\? That device will no longer unlock the wallet\.`\)/);
  assert.match(act, /walletApi\('passkey\/remove', \{ id \}\)/);
  assert.match(act, /await pkUnlock\(walletApi\)/);
  assert.match(act, /await pkAdd\(walletApi, \{ passphrase, label: name \}, confirmStep\);/);
  assert.match(act, /await walletApi\('unlock', \{ passphrase \}\)/);
  assert.ok(act.indexOf("passEl.value = ''") > 0 && act.indexOf("passEl.value = ''") < act.indexOf("await walletApi('unlock'"), 'the passphrase field is emptied before the request');
  assert.ok(act.indexOf("passEl.value = ''") < act.indexOf('await pkAdd('), 'and before the passkey request');
  assert.match(act, /Confirm with Face ID \/ fingerprint/);
  assert.match(act, /walletShowMsg\(pkErrorText\(e\), false\)/);
  assert.ok(!/alert\(/.test(act), 'results are a line in the sheet, not alert()');
  assert.match(block(mob, 'function walletSetBusy(', 'function walletShowMsg('), /el\.disabled = on/, 'buttons disabled while a request runs');
  assert.match(mob, /async function walletApi\(path, body\) \{[\s\S]*?throw new Error\(j\.error \|\| 'Request failed'\)/);
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
