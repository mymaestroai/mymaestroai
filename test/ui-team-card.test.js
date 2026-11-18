'use strict';
// The "Set up your team" card (lib/ui-team-card.js), run in a sandbox with a stand-in document and fetch (the pattern of
// test/welcome-team-page.test.js): nothing for a member or show:false; rows with "billed per use"; Create sends what was
// shown; a changed plan re-renders; Not now posts the answer; server text only ever goes in as text nodes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILE = path.join(__dirname, '..', 'lib', 'ui-team-card.js');
const SRC = fs.readFileSync(FILE, 'utf8');

function node(tag) {
  return {
    tag, className: '', id: '', hidden: false, disabled: false, textContent: '', href: '', children: [], listeners: {}, attrs: {}, parentNode: null,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    replaceChildren(...c) { this.children = c; c.forEach((x) => { x.parentNode = this; }); },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    click() { (this.listeners.click || []).forEach((f) => f()); },
    get text() { return [this.textContent, ...this.children.map((c) => (c.text !== undefined ? c.text : c.textContent || ''))].join(' '); },
    find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.find && c.find(pred, out)); return out; },
  };
}
const ENTRY = (role, name, display, model, over = {}) => ({ role, name, display, icon: '*', model, route: 'Subscription', perUse: false, tier: 'mid', note: null, action: 'create', reason: null, ...over });
const PLAN = [
  ENTRY('challenger', 'challenger', 'Challenger', 'openai/gpt-x', { perUse: true, note: 'Billed per use through an API key.' }),
  ENTRY('scout', 'scout', 'Scout', 'claude-sdk/claude-haiku-5'),
  ENTRY('builder', 'builder', 'Builder', null, { action: 'skip', reason: 'name taken' }),
  ENTRY('researcher', 'researcher', 'Researcher', 'x/y', { action: 'skip', reason: 'interrupted' }),
];

function page({ search = '', first = { status: 200, body: { ok: true, show: true, plan: PLAN, reason: null } } } = {}) {
  const body = node('body');
  const calls = [];
  const waiting = [];
  const doc = { body, createElement: (t) => node(t), createTextNode: (t) => ({ textContent: t }) };
  const fetch = (url, init = {}) => new Promise((resolve) => {
    const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const reply = (status, b) => resolve({ status, json: async () => b });
    if (url.startsWith('/api/team/card') && !url.includes('answer')) reply(first.status, first.body);
    else waiting.push({ call, reply });
  });
  const mod = { exports: {} };
  const ctx = { module: mod, document: doc, fetch, location: { search }, encodeURIComponent, JSON, Promise, console };
  vm.runInNewContext(SRC, ctx, { filename: FILE });
  const settle = async () => { for (let k = 0; k < 8; k++) await new Promise((r) => setImmediate(r)); };
  const answer = async (url, status, b) => {
    const i = waiting.findIndex((w) => w.call.url === url);
    assert.ok(i >= 0, `a request to ${url} is waiting`);
    waiting.splice(i, 1)[0].reply(status, b);
    await settle();
  };
  const card = () => body.children[0];
  const button = (label) => card().find((n) => n.tag === 'button' && n.textContent === label)[0];
  return { TC: mod.exports, body, calls, waiting, answer, settle, card, button, ctx };
}

test('nothing is shown for a member (403), a signed-out request, an error, or show:false', async () => {
  for (const first of [{ status: 403, body: { ok: false, error: 'Admin only' } }, { status: 401, body: {} }, { status: 500, body: null }, { status: 200, body: { ok: true, show: false, plan: PLAN, reason: 'set up' } }]) {
    const p = page({ first });
    assert.strictEqual(await p.TC.start(), false, JSON.stringify(first.status));
    assert.strictEqual(p.body.children.length, 0, 'no card at all');
    assert.strictEqual(p.calls.length, 1);
  }
});

test('the card asks for ?again=1 only after /?team=setup', async () => {
  const a = page({ search: '' }); await a.TC.start(); assert.strictEqual(a.calls[0].url, '/api/team/card');
  const b = page({ search: '?team=setup' }); await b.TC.start(); assert.strictEqual(b.calls[0].url, '/api/team/card?again=1');
  const c = page({ search: '?x=1&team=setup' }); await c.TC.start(); assert.strictEqual(c.calls[0].url, '/api/team/card?again=1');
  const d = page({ search: '?team=other' }); await d.TC.start(); assert.strictEqual(d.calls[0].url, '/api/team/card');
});

test('the card shows the title, the sentence, a row per entry, "billed per use" and the skip reasons', async () => {
  const p = page();
  assert.strictEqual(await p.TC.start(), true);
  const t = p.card().text;
  assert.strictEqual(p.card().id, 'team-card');
  for (const s of ['Set up your team', 'Your lead agent can work with a small team: a Challenger that checks important work, and helpers on cheaper models for the volume. Nothing is added unless you choose it.', 'Challenger', 'Scout', 'Builder', 'Researcher',
    'gpt-x', 'claude-haiku-5', 'billed per use', 'subscription', 'Billed per use through an API key.',
    'You already have an agent called Builder: it is kept as it is', 'An earlier setup of this agent stopped halfway: add it yourself if you want it']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('openai/gpt-x') && !t.includes('claude-sdk/'), 'the model name after the provider prefix');
  const per = p.card().find((n) => /tc-per-use/.test(n.className));
  assert.strictEqual(per.length, 1);
  assert.strictEqual(per[0].textContent, 'billed per use');
  assert.strictEqual(p.button('Create these agents').hidden, false);
  assert.strictEqual(p.button('Not now').hidden, false);
  assert.ok(p.card().find((n) => n.tag === 'button' && n.attrs['aria-label'] === 'Close').length === 1, 'a close button');
  // style rules: warning colour for the per-use one, a bottom sheet on narrow screens, the page's variables
  const css = p.card().find((n) => n.tag === 'style')[0].textContent;
  assert.match(css, /tc-per-use \{ color: var\(--warning\); font-weight: 600/);
  assert.match(css, /@media \(max-width: 520px\)/);
  // Proof review: index.html and mobile.html define --bg-card, not --bg-soft.
  for (const v of ['--bg-card', '--border', '--text', '--text-dim', '--accent']) assert.ok(css.includes(v), v);
});

test('a plan with nothing to create has no Create button', async () => {
  const p = page({ first: { status: 200, body: { ok: true, show: true, plan: PLAN.map((e) => ({ ...e, action: 'skip', reason: 'created before' })), reason: null } } });
  await p.TC.start();
  assert.strictEqual(p.button('Create these agents').hidden, true);
  assert.ok(p.card().text.includes('Already set up'));
});

test('Create sends the roles and models shown (and no model list), disables the buttons while it runs, then shows Change links', async () => {
  const p = page();
  await p.TC.start();
  const go = p.button('Create these agents');
  go.click(); go.click();   // a second press while it runs does nothing
  await p.settle();
  const posts = p.calls.filter((c) => c.url === '/api/welcome/team');
  assert.strictEqual(posts.length, 1, 'one request at a time');
  assert.deepStrictEqual(posts[0].body, { expect: [{ role: 'challenger', model: 'openai/gpt-x' }, { role: 'scout', model: 'claude-sdk/claude-haiku-5' }] });
  assert.strictEqual(go.disabled, true);
  assert.strictEqual(p.button('Not now').disabled, true);
  await p.answer('/api/welcome/team', 200, { ok: true, created: [PLAN[0], PLAN[1]], skipped: [{ ...PLAN[2] }, { ...PLAN[3], reason: 'failed', action: 'skip', error: 'disk busy' }] });
  const links = p.card().find((n) => n.tag === 'a');
  assert.deepStrictEqual(links.map((a) => a.href), ['/agent-settings.html?agent=challenger', '/agent-settings.html?agent=scout']);
  assert.ok(p.card().text.includes('Created.') && p.card().text.includes('disk busy'));
  assert.strictEqual(go.disabled, false);
  assert.strictEqual(go.hidden, true, 'done: no Create button');
  assert.strictEqual(p.button('Not now').hidden, true);
});

test('a 200 with nothing created and only failures keeps the button; other errors give a short line and keep it too', async () => {
  const p = page();
  await p.TC.start();
  p.button('Create these agents').click(); await p.settle();
  await p.answer('/api/welcome/team', 200, { ok: true, created: [], skipped: PLAN.map((e) => ({ ...e, action: 'skip', reason: 'failed', error: 'disk busy' })) });
  assert.match(p.card().text, /could not be created: disk busy/);
  assert.strictEqual(p.button('Create these agents').hidden, false);
  assert.strictEqual(p.button('Create these agents').disabled, false);
  p.button('Create these agents').click(); await p.settle();
  await p.answer('/api/welcome/team', 500, { ok: false });
  assert.match(p.card().text, /could not be created just now/);
  assert.strictEqual(p.button('Create these agents').hidden, false);
  assert.strictEqual(p.calls.filter((c) => c.url === '/api/welcome/team').length, 2);
});

test('a 409 changed re-renders with the new plan and the line; the next Create sends what is now shown', async () => {
  const p = page();
  await p.TC.start();
  p.button('Create these agents').click(); await p.settle();
  const changed = [{ ...PLAN[0], model: 'claude-sdk/claude-sonnet-5', perUse: false, note: null }, PLAN[1], PLAN[2], PLAN[3]];
  await p.answer('/api/welcome/team', 409, { ok: false, changed: true, plan: changed, error: 'The team changed since it was shown' });
  const t = p.card().text;
  assert.ok(t.includes('The team changed since it was shown. Check it, then press Create these agents.'));
  assert.ok(t.includes('claude-sonnet-5') && !t.includes('gpt-x'));
  assert.strictEqual(p.calls.filter((c) => c.url === '/api/welcome/team').length, 1, 'nothing re-sent by itself');
  p.button('Create these agents').click(); await p.settle();
  assert.deepStrictEqual(p.calls.filter((c) => c.url === '/api/welcome/team')[1].body.expect[0], { role: 'challenger', model: 'claude-sdk/claude-sonnet-5' });
});

test('Not now posts the answer and closes; the x only closes for this page load', async () => {
  const p = page();
  await p.TC.start();
  p.button('Not now').click(); await p.settle();
  assert.deepStrictEqual(p.calls[1], { url: '/api/team/card/answer', method: 'POST', body: { answer: 'later' } });
  await p.answer('/api/team/card/answer', 200, { ok: true });
  assert.strictEqual(p.body.children.length, 0, 'closed');
  const q = page();
  await q.TC.start();
  q.card().find((n) => n.tag === 'button' && n.attrs['aria-label'] === 'Close')[0].click();
  assert.strictEqual(q.body.children.length, 0, 'closed');
  assert.strictEqual(q.calls.length, 1, 'no answer was sent: it comes back next load');
  // an answer that could not be recorded still closes the card
  const r = page();
  await r.TC.start();
  r.button('Not now').click(); await r.settle();
  await r.answer('/api/team/card/answer', 409, { ok: false });
  assert.strictEqual(r.body.children.length, 0);
});

test('server text only goes in as text nodes: no innerHTML or markup writes in the file, and markup in names stays text', async () => {
  assert.doesNotMatch(SRC, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(SRC, /\uFE0F/u);
  const evil = [ENTRY('scout', 'scout', '<img src=x onerror=alert(1)>', 'a/<b>x</b>', { note: '<script>1</script>' })];
  const p = page({ first: { status: 200, body: { ok: true, show: true, plan: evil, reason: null } } });
  await p.TC.start();
  assert.ok(p.card().text.includes('<img src=x onerror=alert(1)>') && p.card().text.includes('<script>1</script>'));
  assert.strictEqual(p.card().find((n) => n.tag === 'img' || n.tag === 'script').length, 0, 'no element was made from the text');
});

test('the module exports its functions for tests and for window.TeamCard', () => {
  const p = page();
  for (const f of ['start', 'create', 'notNow', 'close', 'render']) assert.strictEqual(typeof p.TC[f], 'function', f);
  assert.match(SRC, /root\.TeamCard = api/);
});
