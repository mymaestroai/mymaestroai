'use strict';
// lib/ui-claude-signin.js: the "Claude is signed out" notice, the guided sign-in panel and the health button.
// A small fake DOM and a fake fetch stand in for the browser and the hub (the routes are in the part 2 contract).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- fake DOM ----
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.id = '';
    this.value = '';
    this.hidden = false;
    this._text = '';
    this.style = {};
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatch(t, ev) { for (const f of (this.listeners[t] || []).slice()) f(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev || {})); }
  click() { this.dispatch('click'); }
  focus() { global.document.activeElement = this; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  walk(fn) { fn(this); for (const c of this.children) c.walk(fn); }
  all() { const out = []; this.walk((n) => out.push(n)); return out; }
  querySelectorAll(sel) { const tags = sel.split(',').map((s) => s.trim().replace(/\[.*\]/, '').toUpperCase()); return this.all().filter((n) => n !== this && tags.includes(n.tagName)); }
}
function makeDocument() {
  const body = new Node('body');
  const head = new Node('head');
  const listeners = {};
  const doc = {
    body, head, activeElement: null,
    createElement: (t) => new Node(t),
    getElementById: (id) => { let f = null; head.walk((n) => { if (!f && n.id === id) f = n; }); body.walk((n) => { if (!f && n.id === id) f = n; }); return f; },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    key: (key) => { for (const f of (listeners.keydown || []).slice()) f({ key, preventDefault() {}, stopPropagation() {} }); },
    listenerCount: (t) => (listeners[t] || []).length,
  };
  return doc;
}

// ---- fake hub ----
const WORDS = {
  signedOut: 'Claude is signed out on the computer that runs your Maestro.',
  openLink: 'Open this link on any computer or phone, sign in with the Claude account that has your plan, and approve.',
  pasteCode: 'The page then shows a code. Copy all of it and paste it here.',
  checking: 'Checking that Claude answers…',
  done: 'Signed in. Claude answers again. Send your message again.',
};
let hub, calls, doc;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(3); } return !!fn(); }

function resetHub(over) {
  hub = Object.assign({
    me: { canSignIn: true, signedIn: false, adminName: null, words: WORDS, attempt: { state: 'idle' } },
    attempt: { state: 'idle' },
    status: 200,
    codeAnswer: null,
    id: 'att-1',   // the id the fake server gives an attempt that does not name one
  }, over || {});
  calls = [];
}
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
// Every attempt the server shows carries its id (the page binds to it): one that a test wrote without an id gets hub.id.
const stamp = (a) => (a && typeof a === 'object' && !a.id ? { ...a, id: hub.id } : a);
global.fetch = async (url, init) => {
  const method = (init && init.method) || 'GET';
  calls.push({ url, method, body: init && init.body ? JSON.parse(init.body) : null });
  if (method === 'GET') return json(200, Object.assign({}, hub.me, hub.me.canSignIn ? { attempt: stamp(hub.attempt) } : {}));
  if (hub.status === 403) return json(403, { ok: false, error: 'Sign in with an admin account in your browser to do this.' });
  const sentId = init && init.body ? JSON.parse(init.body).id : undefined;
  // /code and /cancel with another id are stale (409 with no attempt), like the server
  const stale = () => stamp(hub.attempt) && sentId !== stamp(hub.attempt).id;
  if (url.endsWith('/start')) {
    if (hub.startGate) await hub.startGate;   // a test can hold the answer back
    hub.attempt = stamp(hub.startAttempt || { state: 'starting' });
    return json(200, { ok: true, id: hub.attempt.id, attempt: hub.attempt });
  }
  if (url.endsWith('/cancel')) {
    if (stale()) return json(409, { ok: false, reason: 'stale' });
    hub.attempt = { state: 'cancelled', id: stamp(hub.attempt).id }; return json(200, { ok: true, attempt: hub.attempt });
  }
  if (url.endsWith('/code')) {
    if (stale()) return json(409, { ok: false, reason: 'stale' });
    if (hub.codeAnswer) return json(200, Object.assign({}, hub.codeAnswer, hub.codeAnswer.attempt ? { attempt: stamp(hub.codeAnswer.attempt) } : {}));
    hub.attempt = stamp({ state: 'checking' });
    return json(200, { ok: true, attempt: hub.attempt });
  }
  return json(404, {});
};

let CS;
beforeEach(() => {
  doc = makeDocument();
  global.document = doc;
  CS = require('../lib/ui-claude-signin');
  CS._reset();
  resetHub();
});

const all = () => doc.body.all();
const buttons = () => all().filter((n) => n.tagName === 'BUTTON' || (n.tagName === 'A' && n.getAttribute('href')));
const byLabel = (l) => buttons().find((b) => b.textContent === l);
const bodyText = () => doc.body.textContent;
const dialog = () => all().find((n) => n.getAttribute('role') === 'dialog');

async function noticeFor(opts) {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const card = CS.notice(host, opts);
  await sleep(10);
  return { host, card };
}

// ---- the notice ----
test('admin notice: the sentence, a Sign in again button and the terminal line', async () => {
  const { card } = await noticeFor({ detail: 'Not logged in' });
  assert.match(card.className, /cs-notice/);
  assert.match(card.textContent, /Claude is signed out on the computer that runs your Maestro\./);
  assert.ok(byLabel('Sign in again'));
  assert.match(card.textContent, /Or on that computer, in a terminal: mymaestro connect claude/);
});

test('member notice: names the admin, no button', async () => {
  resetHub({ me: { canSignIn: false, signedIn: null, adminName: 'Sam', words: WORDS } });
  const { card } = await noticeFor({});
  assert.match(card.textContent, /Ask Sam to sign in again\./);
  assert.equal(byLabel('Sign in again'), undefined);
  assert.doesNotMatch(card.textContent, /mymaestro connect claude/);
});

test('member notice with no admin name asks an admin of your Maestro', async () => {
  resetHub({ me: { canSignIn: false, signedIn: null, adminName: null, words: WORDS } });
  const { card } = await noticeFor({});
  assert.match(card.textContent, /Ask an admin of your Maestro to sign in again\./);
  assert.equal(byLabel('Sign in again'), undefined);
});

test('the notice is drawn once per element and fetches the hub once (cached)', async () => {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const a = CS.notice(host, {});
  const b = CS.notice(host, {});
  assert.equal(a, b);
  const other = doc.createElement('div');
  doc.body.appendChild(other);
  CS.notice(other, {});
  await sleep(10);
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1);
  assert.equal(doc.getElementById('cs-style') !== null, true);
  assert.equal(doc.head.all().filter((n) => n.id === 'cs-style').length, 1, 'one style element');
});

test('what Claude said: hidden by default, shown on a click, and always text', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const { card } = await noticeFor({ detail: evil });
  const area = card.all().find((n) => n.className === 'cs-detail');
  assert.ok(area);
  assert.equal(area.hidden, true);
  assert.equal(area.textContent, evil);
  assert.equal(area.children.length, 0, 'no child elements: the text is not parsed');
  assert.equal(card.all().filter((n) => n.tagName === 'IMG').length, 0);
  byLabel('What Claude said').click();
  assert.equal(area.hidden, false);
});

test('a server sentence with markup stays text', async () => {
  resetHub({ me: { canSignIn: false, adminName: '<b>Sam</b>', words: Object.assign({}, WORDS, { signedOut: '<i>out</i>' }) } });
  const { card } = await noticeFor({});
  assert.equal(card.all().filter((n) => n.tagName === 'B' || n.tagName === 'I').length, 0);
  assert.match(card.textContent, /<i>out<\/i>/);
  assert.match(card.textContent, /Ask <b>Sam<\/b> to sign in again\./);
});

// ---- the panel ----
test('panel: starts, shows the link, takes the code, checks, is done, and sends the message again', async () => {
  resetHub({ startAttempt: { state: 'starting' } });
  let resent = 0;
  const opener = doc.createElement('button');
  doc.body.appendChild(opener);
  opener.focus();
  CS.openPanel({ onResend: () => { resent++; }, pollMs: 5 });
  const dlg = dialog();
  assert.ok(dlg, 'a dialog');
  assert.equal(dlg.getAttribute('aria-modal'), 'true');
  const labelId = dlg.getAttribute('aria-labelledby');
  assert.equal(doc.getElementById(labelId).textContent, 'Sign in to Claude again');
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/start')), 'POST start');
  assert.match(bodyText(), /Starting…/);

  // the server reaches the link state
  hub.attempt = { state: 'link', link: 'https://claude.ai/oauth/authorize?code=true&x=1' };
  assert.ok(await until(() => byLabel('Open the sign-in page')), 'the link button shows');
  const open = byLabel('Open the sign-in page');
  assert.equal(open.getAttribute('href'), 'https://claude.ai/oauth/authorize?code=true&x=1');
  assert.equal(open.getAttribute('target'), '_blank');
  assert.equal(open.getAttribute('rel'), 'noopener noreferrer');
  assert.ok(byLabel('Copy link'));
  assert.match(bodyText(), new RegExp(WORDS.openLink.slice(0, 30)));
  assert.match(bodyText(), new RegExp(WORDS.pasteCode.slice(0, 30)));
  const input = all().find((n) => n.tagName === 'INPUT');
  assert.equal(input.getAttribute('autocomplete'), 'off');
  assert.equal(input.getAttribute('autocapitalize'), 'off');
  assert.equal(input.getAttribute('spellcheck'), 'false');
  assert.notEqual(input.getAttribute('name'), 'password');
  assert.notEqual(input.getAttribute('type'), 'password');

  // the code goes with the request, the input is empty right away and the code is in no element's text
  input.value = 'SECRET-CODE-123#state';
  byLabel('Continue').click();
  assert.equal(input.value, '', 'cleared at once');
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/code')));
  const sent = calls.find((c) => c.url === '/api/claude-signin/code');
  assert.deepEqual(sent.body, { code: 'SECRET-CODE-123#state', id: 'att-1' });
  await sleep(20);
  for (const n of all()) assert.ok(!String(n.textContent).includes('SECRET-CODE-123'), 'the code is in no text');
  assert.ok(await until(() => /Checking that Claude answers/.test(bodyText())), 'checking');

  hub.attempt = { state: 'done' };
  assert.ok(await until(() => byLabel('Send my message again')), 'done');
  assert.match(bodyText(), /Signed in\. Claude answers again/);
  byLabel('Send my message again').click();
  assert.equal(resent, 1);
  assert.equal(dialog(), undefined, 'the panel closed');
  assert.equal(doc.activeElement, opener, 'the focus went back');
  assert.equal(doc.listenerCount('keydown'), 0);
});

test('panel: Enter submits the code', async () => {
  resetHub({ startAttempt: { state: 'link', link: 'https://claude.ai/x' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => all().some((n) => n.tagName === 'INPUT')));
  const input = all().find((n) => n.tagName === 'INPUT');
  input.value = 'abc#def';
  input.dispatch('keydown', { key: 'Enter' });
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/code')));
});

test('panel: a javascript: link is not rendered as a link and the error sentence shows', async () => {
  resetHub({ startAttempt: { state: 'link', link: 'javascript:alert(1)' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => all().some((n) => n.tagName === 'INPUT')));
  assert.equal(byLabel('Open the sign-in page'), undefined);
  assert.equal(all().filter((n) => n.getAttribute('href')).length, 0);
  assert.equal(byLabel('Copy link'), undefined);
  assert.match(bodyText(), /link didn't look right/);
});

test('panel: a code that is not whole shows the inline line and stays', async () => {
  resetHub({ startAttempt: { state: 'link', link: 'https://claude.ai/x' }, codeAnswer: { ok: false, reason: 'format', attempt: { state: 'link', link: 'https://claude.ai/x' } } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => all().some((n) => n.tagName === 'INPUT')));
  const input = all().find((n) => n.tagName === 'INPUT');
  input.value = 'short';
  byLabel('Continue').click();
  assert.ok(await until(() => /doesn't look like the whole code\. Copy all of it and paste it again\./.test(bodyText())));
  assert.ok(all().some((n) => n.tagName === 'INPUT'), 'still on the code step');
  assert.ok(byLabel('Continue'));
});

test('panel: failed shows the message and Start again posts start again', async () => {
  resetHub({ startAttempt: { state: 'failed', message: "That code didn't work: it may have expired." } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => byLabel('Start again')));
  assert.match(bodyText(), /That code didn't work/);
  const before = calls.filter((c) => c.url === '/api/claude-signin/start').length;
  assert.equal(before, 1);
  hub.startAttempt = { state: 'starting' };
  byLabel('Start again').click();
  assert.ok(await until(() => calls.filter((c) => c.url === '/api/claude-signin/start').length === 2));
});

test('panel: closing while the link shows posts cancel and stops polling; Escape closes too', async () => {
  resetHub({ startAttempt: { state: 'link', link: 'https://claude.ai/x' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => byLabel('Open the sign-in page')));
  assert.ok(await until(() => calls.filter((c) => c.method === 'GET').length >= 3), 'polling');
  byLabel('Close').click();
  assert.equal(dialog(), undefined);
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/cancel')));
  const n = calls.length;
  await sleep(40);
  assert.equal(calls.length, n, 'no requests after the panel closed');

  // Escape
  resetHub({ startAttempt: { state: 'link', link: 'https://claude.ai/x' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => byLabel('Open the sign-in page')));
  doc.key('Escape');
  assert.equal(dialog(), undefined);
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/cancel')));
});

test('panel: the attempt id from the start answer and the polls goes with /code and /cancel', async () => {
  resetHub({ startAttempt: { state: 'starting', id: 'att-1' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/start')));
  hub.attempt = { state: 'link', id: 'att-1', link: 'https://claude.ai/oauth/authorize?x=1' };
  assert.ok(await until(() => byLabel('Open the sign-in page')));
  const input = all().find((n) => n.tagName === 'INPUT');
  input.value = 'SECRET-CODE-123#state';
  byLabel('Continue').click();
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/code')));
  assert.deepEqual(calls.find((c) => c.url === '/api/claude-signin/code').body, { code: 'SECRET-CODE-123#state', id: 'att-1' });
  // back to a link state (a fresh poll), then close: the cancel names the attempt
  hub.attempt = { state: 'link', id: 'att-1', link: 'https://claude.ai/oauth/authorize?x=1' };
  assert.ok(await until(() => byLabel('Close') && byLabel('Open the sign-in page')));
  byLabel('Close').click();
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/cancel')));
  assert.deepEqual(calls.find((c) => c.url === '/api/claude-signin/cancel').body, { id: 'att-1' });
  assert.equal(hub.attempt.state, 'cancelled', 'the server took the cancel (not stale)');
});

test('panel: a stale answer (409) does not adopt the other attempt: the panel says so, offers Start again, and a close cancels nothing', async () => {
  resetHub({ startAttempt: { state: 'link', id: 'att-1', link: 'https://claude.ai/first' } });
  CS.openPanel({ pollMs: 100000 });
  assert.ok(await until(() => byLabel('Open the sign-in page')));
  assert.equal(byLabel('Open the sign-in page').getAttribute('href'), 'https://claude.ai/first');
  // another admin started a new attempt meanwhile
  hub.attempt = { state: 'link', id: 'att-2', link: 'https://claude.ai/second' };
  all().find((n) => n.tagName === 'INPUT').value = 'SECRET-CODE-123#state';
  byLabel('Continue').click();
  assert.ok(await until(() => /ended or was replaced/.test(bodyText())), 'the lost attempt is said');
  assert.ok(byLabel('Start again'));
  assert.equal(all().filter((n) => n.tagName === 'INPUT').length, 0, 'no code box any more');
  assert.equal(byLabel('Open the sign-in page'), undefined, 'the other attempt\'s link is not shown');
  assert.doesNotMatch(bodyText(), /SECRET-CODE-123/);
  assert.equal(calls.filter((c) => c.url === '/api/claude-signin/start').length, 1, 'no second start');
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1, 'no re-read that would adopt the other attempt (only the opening read)');
  byLabel('Close').click();
  await sleep(20);
  assert.equal(calls.filter((c) => c.url === '/api/claude-signin/cancel').length, 0, 'the other attempt is not cancelled');
});

test('panel: closed while /start is in flight, the late answer is cancelled once, with that attempt\'s id', async () => {
  let release;
  resetHub({ startGate: new Promise((r) => { release = r; }), startAttempt: { state: 'starting', id: 'att-A' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/start')));
  doc.key('Escape');   // closed before the start answered: the panel has no id to cancel yet
  assert.equal(dialog(), undefined);
  assert.equal(calls.filter((c) => c.url === '/api/claude-signin/cancel').length, 0);
  release();
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/cancel')));
  await sleep(30);
  const cancels = calls.filter((c) => c.url === '/api/claude-signin/cancel');
  assert.equal(cancels.length, 1, 'exactly one cancel');
  assert.deepEqual(cancels[0].body, { id: 'att-A' });
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1, 'and no polling for it');
});

test('panel: a poll that returns another attempt while a code is typed: the box goes, no code reaches the other attempt, no cancel of it on close', async () => {
  resetHub({ startAttempt: { state: 'link', id: 'att-A', link: 'https://claude.ai/a' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => all().some((n) => n.tagName === 'INPUT')));
  all().find((n) => n.tagName === 'INPUT').value = 'SECRET-CODE-123#state';   // typed, not sent
  hub.attempt = { state: 'link', id: 'att-B', link: 'https://claude.ai/b' };   // somebody else's attempt B replaced A
  assert.ok(await until(() => /ended or was replaced/.test(bodyText())));
  assert.equal(all().filter((n) => n.tagName === 'INPUT').length, 0, 'the box disappeared');
  assert.equal(byLabel('Open the sign-in page'), undefined);
  const nGets = calls.filter((c) => c.method === 'GET').length;
  await sleep(40);
  assert.equal(calls.filter((c) => c.method === 'GET').length, nGets, 'polling stopped');
  byLabel('Close').click();
  await sleep(20);
  assert.equal(calls.filter((c) => c.url === '/api/claude-signin/code').length, 0, 'no code went anywhere');
  assert.equal(calls.filter((c) => c.url === '/api/claude-signin/cancel').length, 0, 'B was not cancelled');
  assert.equal(hub.attempt.state, 'link', 'B is untouched');
});

test('panel: a /start answer that is busy or has no id binds nothing and cancels nothing', async () => {
  const realFetch = global.fetch;
  resetHub({});
  global.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    calls.push({ url, method, body: init && init.body ? JSON.parse(init.body) : null });
    if (method === 'GET') return json(200, Object.assign({}, hub.me, { attempt: { state: 'idle' } }));
    if (url.endsWith('/start')) return json(200, { ok: false, reason: 'busy', attempt: { state: 'link', id: 'att-B', link: 'https://claude.ai/b' } });
    return json(404, {});
  };
  try {
    CS.openPanel({ pollMs: 5 });
    assert.ok(await until(() => /Another sign-in is in progress/.test(bodyText())));
    assert.equal(all().filter((n) => n.tagName === 'INPUT').length, 0, 'the other attempt is not adopted');
    byLabel('Close').click();
    await sleep(20);
    assert.equal(calls.filter((c) => c.url.endsWith('/cancel')).length, 0);
  } finally { global.fetch = realFetch; }
});

test('panel: installing shows that Claude Code is being installed, keeps polling, and closing cancels it', async () => {
  resetHub({ startAttempt: { state: 'starting', id: 'att-1' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/start')));
  hub.attempt = { state: 'installing', id: 'att-1' };
  assert.ok(await until(() => /Installing Claude Code on that computer…/.test(bodyText())), 'the installing sentence');
  assert.deepEqual(buttons().map((b) => b.textContent), ['Close']);
  // it goes on to the link when the install is done
  hub.attempt = { state: 'link', id: 'att-1', link: 'https://claude.ai/oauth/authorize?x=1' };
  assert.ok(await until(() => byLabel('Open the sign-in page')));
  assert.doesNotMatch(bodyText(), /Installing Claude Code/);
  // an open panel that finds an installing attempt resumes it (no second start)
  CS._reset();
  doc.body.all().filter((n) => n.getAttribute && n.getAttribute('role') === 'dialog').forEach((n) => n.parentNode && n.parentNode.removeChild(n));
  resetHub({ attempt: { state: 'installing', id: 'att-9' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => /Installing Claude Code on that computer…/.test(bodyText())));
  assert.equal(calls.filter((c) => c.url === '/api/claude-signin/start').length, 0);
  byLabel('Close').click();
  assert.ok(await until(() => calls.some((c) => c.url === '/api/claude-signin/cancel')), 'closing while installing cancels');
  assert.deepEqual(calls.find((c) => c.url === '/api/claude-signin/cancel').body, { id: 'att-9' });
});

test('panel: reopening while an attempt runs resumes it (no second start)', async () => {
  resetHub({ attempt: { state: 'link', link: 'https://claude.ai/x' } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => byLabel('Open the sign-in page')));
  assert.equal(calls.filter((c) => c.url === '/api/claude-signin/start').length, 0);
});

test('panel: a 403 shows its error text and only Close', async () => {
  resetHub({ status: 403, startAttempt: null });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => /Sign in with an admin account in your browser to do this\./.test(bodyText())));
  assert.deepEqual(buttons().map((b) => b.textContent), ['Close']);
  byLabel('Close').click();
  assert.equal(calls.some((c) => c.url.endsWith('/cancel')), false, 'a refused panel cancels nothing');
});

test('panel: a member who opens it is told whom to ask', async () => {
  resetHub({ me: { canSignIn: false, adminName: 'Sam', words: WORDS } });
  CS.openPanel({ pollMs: 5 });
  assert.ok(await until(() => /Ask Sam to sign in again\./.test(bodyText())));
  assert.deepEqual(buttons().map((b) => b.textContent), ['Close']);
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

test('only one panel at a time', async () => {
  resetHub({ startAttempt: { state: 'link', link: 'https://claude.ai/x' } });
  CS.openPanel({ pollMs: 5 });
  CS.openPanel({ pollMs: 5 });
  assert.equal(all().filter((n) => n.getAttribute('role') === 'dialog').length, 1);
  doc.key('Escape');
});

// ---- the health button ----
test('healthButton: a button for action claude-signin, null for anything else', () => {
  const b = CS.healthButton({ id: 'health-claude-signedout', action: 'claude-signin' });
  assert.ok(b);
  assert.equal(b.textContent, 'Sign in again');
  assert.equal(CS.healthButton({ id: 'x', action: 'other' }), null);
  assert.equal(CS.healthButton({ id: 'x' }), null);
  assert.equal(CS.healthButton(null), null);
});

test('healthButton opens the panel without a resend button', async () => {
  resetHub({ startAttempt: { state: 'done' } });
  const b = CS.healthButton({ action: 'claude-signin' });
  doc.body.appendChild(b);
  b.click();
  assert.ok(dialog());
  assert.ok(await until(() => /Signed in\. Claude answers again/.test(bodyText())));
  assert.equal(byLabel('Send my message again'), undefined);
  assert.ok(byLabel('Close'));
  byLabel('Close').click();
});

// ---- page wiring (source level) ----
test('app.js and mobile.js handle the live event, the saved rows and the health button', () => {
  const app = read('app.js'), mob = read('mobile.js');
  assert.match(app, /oc\.type === 'claude_signin'/);
  assert.match(app, /oc2\.type === 'claude_signin'/);
  assert.match(app, /msg\.claudeSignin === true/);
  assert.match(app, /msg\.claudeSigninDetail/);
  assert.match(app, /ClaudeSignin\.healthButton\(i\)/);
  assert.match(app, /ClaudeSignin\.healthButton\(items\[idx\]\)/, 'the Settings health list');
  assert.match(app, /ClaudeSignin\.notice\(wrap, \{ detail, onResend \}\)/);
  assert.match(app, /bubble\.dataset\.claudeSignin/, 'one notice per reply');
  assert.match(mob, /case 'claude_signin':/);
  assert.match(mob, /m\.claudeSignin === true/);
  assert.match(mob, /m\.claudeSigninDetail/);
  assert.match(mob, /ClaudeSignin\.healthButton\(i\)/);
  assert.match(mob, /bubbleEl\.dataset\.claudeSignin/, 'one notice per reply');
});

test('both pages load /ui-claude-signin.js before their own script, and the file is served', () => {
  const idx = read('index.html'), mob = read('mobile.html');
  assert.ok(idx.includes('<script src="/ui-claude-signin.js"></script>'));
  assert.ok(mob.includes('<script src="/ui-claude-signin.js"></script>'));
  assert.ok(idx.indexOf('/ui-claude-signin.js') < idx.indexOf('<script src="app.js">'));
  assert.ok(mob.indexOf('/ui-claude-signin.js') < mob.indexOf('<script src="mobile.js">'));
  assert.match(read('lib/static-files.js'), /\['ui-claude-signin\.js', 'lib\/ui-claude-signin\.js'\]/);
});

test('the phone service worker is v78', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v86';/);
});

test('the script keeps server text out of markup and has no variation selector', () => {
  const src = read('lib/ui-claude-signin.js');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.equal(src.includes('\uFE0F'), false);
});
