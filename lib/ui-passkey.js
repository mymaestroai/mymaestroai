'use strict';
/**
 * ui-passkey.js — the browser side of unlocking the trading wallet with Face ID, a fingerprint or the screen lock
 * (WebAuthn with the PRF extension). The pages carry byte-identical copies between the markers below (app.js,
 * mobile.js); test/ui-passkey.test.js proves the copies match and tests the behaviour here. No DOM in these functions.
 *
 *   pkB64u(buf), pkBytes(s)            ArrayBuffer/Uint8Array <-> base64url without padding
 *   pkUsable(loc, w)                   { ok, code, text }: whether this page's browser and address can use passkeys
 *   pkErrorText(e)                     a plain sentence for a WebAuthn error
 *   pkUnlock(api)                      ask the hub for a challenge, ask the device, send the answer; resolves with the
 *                                      wallet status the hub returns
 *   pkAdd(api, { passphrase, label }, confirmStep)
 *                                      set this device up (the passphrase is needed once); confirmStep() returns a
 *                                      Promise resolved by a fresh tap when a second prompt is needed
 *   pkDeviceLabel(nav)                 a short default name: 'iPhone', 'Mac', ...
 *   api(path, body) is the page's own call to /api/wallet/<path> (POST with a body), resolving with the JSON.
 */
// ── passkey helpers (begin) ──
function pkB64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pkBytes(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function pkUsable(loc = location, w = window) {
  if (!w.PublicKeyCredential || !navigator.credentials) return { ok: false, code: 'no_api', text: "This browser can't use passkeys." };
  const host = loc.hostname || '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return { ok: false, code: 'bad_address', text: `Passkeys can't be used at the address ${host}. Open My Maestro at localhost or at its tailnet address instead.` };
  }
  if (loc.protocol === 'http:' && host !== 'localhost') {
    return { ok: false, code: 'bad_address', text: `Face ID / fingerprint needs a secure (https) address, or localhost. This page is at ${host}.` };
  }
  return { ok: true, code: '', text: '' };
}
function pkErrorText(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError') return 'Cancelled, or the device did not confirm it was you.';
  if (name === 'InvalidStateError') return 'This device is already set up.';
  if (name === 'SecurityError') return "This address can't use passkeys.";
  if (name === 'AbortError') return 'Cancelled.';
  return (e && e.message) || 'Something went wrong.';
}
async function pkUnlock(api) {
  const o = await api('passkey/options', { purpose: 'unlock' });
  const one = o.allowCredentials.length === 1;
  const byCred = {};
  for (const c of o.allowCredentials) byCred[c.id] = { first: pkBytes(o.prfSalts[c.id]) };
  const publicKey = {
    challenge: pkBytes(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: 'required',
    allowCredentials: o.allowCredentials.map(c => ({ type: 'public-key', id: pkBytes(c.id) })),
    extensions: { prf: { evalByCredential: byCred, ...(one ? { eval: { first: pkBytes(o.prfSalts[o.allowCredentials[0].id]) } } : {}) } },
  };
  const cred = await navigator.credentials.get({ publicKey });
  const prf = cred.getClientExtensionResults().prf?.results?.first;
  if (!prf) throw new Error("This device didn't give the unlock secret. Use the passphrase instead.");
  return api('passkey/unlock', {
    challenge: o.challenge, id: cred.id,
    clientDataJSON: pkB64u(cred.response.clientDataJSON), authenticatorData: pkB64u(cred.response.authenticatorData),
    signature: pkB64u(cred.response.signature), prf: pkB64u(prf),
  });
}
async function pkAdd(api, { passphrase, label }, confirmStep) {
  const o = await api('passkey/options', { purpose: 'register', passphrase });
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: pkBytes(o.challenge), rp: o.rp, user: { ...o.user, id: pkBytes(o.user.id) }, pubKeyCredParams: o.pubKeyCredParams,
    timeout: o.timeout, attestation: 'none', authenticatorSelection: o.authenticatorSelection,
    excludeCredentials: o.excludeCredentials.map(c => ({ type: 'public-key', id: pkBytes(c.id) })),
    extensions: { prf: { eval: { first: pkBytes(o.prfSalt) } } },
  } });
  const ext = cred.getClientExtensionResults().prf;
  if (ext && ext.enabled === false) throw new Error("This device's passkeys can't unlock the wallet. Keep using the passphrase here.");
  const pub = cred.response.getPublicKey ? cred.response.getPublicKey() : null;
  if (!pub) throw new Error("This device's passkey type isn't supported here.");
  let prf = ext?.results?.first, confirm;
  if (!prf) {
    await confirmStep();
    const c = await api('passkey/options', { purpose: 'confirm', registerChallenge: o.challenge });
    const g = await navigator.credentials.get({ publicKey: {
      challenge: pkBytes(c.challenge), rpId: c.rpId, timeout: c.timeout, userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: cred.rawId }],
      extensions: { prf: { eval: { first: pkBytes(c.prfSalt) } } },
    } });
    prf = g.getClientExtensionResults().prf?.results?.first;
    if (!prf) throw new Error("This device didn't give the unlock secret, so it can't unlock the wallet.");
    confirm = { challenge: c.challenge, clientDataJSON: pkB64u(g.response.clientDataJSON), authenticatorData: pkB64u(g.response.authenticatorData), signature: pkB64u(g.response.signature) };
  }
  return api('passkey/register', {
    passphrase, label, challenge: o.challenge,
    credential: {
      id: cred.id, clientDataJSON: pkB64u(cred.response.clientDataJSON), authenticatorData: pkB64u(cred.response.getAuthenticatorData()),
      publicKey: pkB64u(pub), publicKeyAlgorithm: cred.response.getPublicKeyAlgorithm(),
    },
    prf: pkB64u(prf), ...(confirm ? { confirm } : {}),
  });
}
function pkDeviceLabel(nav = navigator) {
  const ua = String((nav && nav.userAgent) || '');
  const plat = String((nav && nav.userAgentData && nav.userAgentData.platform) || '');
  if (/iPhone|iPod/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && nav.maxTouchPoints > 1)) return 'iPad';
  if (/^Android$/i.test(plat) || /Android/i.test(ua)) return 'Android phone';
  if (/^macOS$/i.test(plat) || /Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/^Windows$/i.test(plat) || /Windows/i.test(ua)) return 'Windows PC';
  if (/^(Linux|Chrome OS|Chromium OS)$/i.test(plat) || /Linux|X11|CrOS/i.test(ua)) return 'Linux computer';
  return 'This device';
}
// ── passkey helpers (end) ──

module.exports = { pkB64u, pkBytes, pkUsable, pkErrorText, pkUnlock, pkAdd, pkDeviceLabel };
