'use strict';
// Phone: Activity moved from the bottom bar into the ⋮ menu (2026-10-29: it was easy to tap by accident). The page's
// own show() and updateDots() run against stand-in elements, with no Activity tab in the bar.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}

function page() {
  const cls = () => { const set = new Set(); return { toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); }, remove: (c) => set.delete(c), contains: (c) => set.has(c) }; };
  const els = {};
  for (const id of ['screen-agents', 'screen-chat', 'screen-activity', 'tab-agents', 'tab-chat', 'menu', 'act-unread', 'chat-unread', 'agents-approvals']) els[id] = { id, textContent: '', classList: cls() };
  const calls = [];
  const make = new Function('$', 'unread', 'approvals', 'renderAgents', 'renderActivity', 'loadActivityExtras', `
    let screen = 'agents', actUnseen = 0;
    ${extract('updateDots')}
    ${extract('show')}
    return { show, updateDots, bump: (n) => { actUnseen += n; updateDots(); }, state: () => ({ screen, actUnseen }) };`);
  const api = make((id) => els[id] || null, {}, new Set(), () => calls.push('agents'), () => calls.push('activity'), () => calls.push('extras'));
  return { els, calls, api };
}

test('Activity opens from the menu: no tab needed, the menu closes, its screen shows', () => {
  const { els, calls, api } = page();
  els.menu.classList.toggle('open', true);
  assert.doesNotThrow(() => api.show('activity'), 'no Activity tab in the bar');
  assert.ok(els['screen-activity'].classList.contains('active') && !els['screen-agents'].classList.contains('active'));
  assert.ok(!els.menu.classList.contains('open'), 'the menu closes');
  assert.ok(!els['tab-agents'].classList.contains('active') && !els['tab-chat'].classList.contains('active'), 'neither remaining tab lights up');
  assert.deepStrictEqual(calls, ['activity', 'extras']);
  api.show('agents');
  assert.ok(els['tab-agents'].classList.contains('active') && els['screen-agents'].classList.contains('active'), 'back to Agents from the bar');
});

test('the count of new activity sits next to Activity in the menu and clears once it is opened', () => {
  const { els, api } = page();
  api.bump(3);
  assert.deepStrictEqual([els['act-unread'].textContent, els['act-unread'].classList.contains('on')], ['3', true]);
  api.bump(120);
  assert.strictEqual(els['act-unread'].textContent, '99+');
  api.show('activity');
  assert.deepStrictEqual([api.state().actUnseen, els['act-unread'].classList.contains('on')], [0, false]);
});

test('a page cached before the move (with the old tab) still works, and a page without the count element does not throw', () => {
  const { els, api } = page();
  els['tab-activity'] = { id: 'tab-activity', classList: { toggle() {}, remove() {}, contains: () => false } };
  assert.doesNotThrow(() => api.show('activity'));
  delete els['act-unread'];
  assert.doesNotThrow(() => api.bump(1));
  assert.ok(src.includes("$('tab-activity')?.addEventListener('click', () => navigate('activity'));"));
});

// mobile.js as it was before the move (bb5acb1): a phone can pair the new page with this cached script when a fetch
// fails. It looks up every tab by id without a guard, so the page keeps an invisible #tab-activity for it.
const OLD = `
function updateDots() {
  const total = Object.values(unread).reduce((s, n) => s + n, 0);
  const c = $('chat-unread');
  c.textContent = total > 99 ? '99+' : String(total);
  c.classList.toggle('on', total > 0);
  const a = $('act-unread');
  a.textContent = actUnseen > 99 ? '99+' : String(actUnseen);
  a.classList.toggle('on', actUnseen > 0 && screen !== 'activity');
  const ap = $('agents-approvals');
  if (ap) { ap.textContent = String(approvals.size); ap.classList.toggle('on', approvals.size > 0); }
}
function show(name) {
  screen = name;
  for (const s of ['agents', 'chat', 'activity']) {
    $(\`screen-\${s}\`).classList.toggle('active', s === name);
    $(\`tab-\${s}\`).classList.toggle('active', s === name);
  }
  $('menu').classList.remove('open');
  if (name === 'agents') renderAgents();
  if (name === 'activity') { actUnseen = 0; renderActivity(); loadActivityExtras(); }
  updateDots();
}`;
test('the page as shipped still works with the script from before the move (a cached mobile.js)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const cls = () => { const set = new Set(); return { toggle: (c, on) => { if (on) set.add(c); else set.delete(c); }, remove: (c) => set.delete(c), contains: (c) => set.has(c) }; };
  const el = (id) => (ids.has(id) ? { id, textContent: '', classList: cls() } : null);
  const els = {};
  const $ = (id) => (id in els ? els[id] : (els[id] = el(id)));
  const make = new Function('$', 'unread', 'approvals', 'renderAgents', 'renderActivity', 'loadActivityExtras', `let screen = 'agents', actUnseen = 2; ${OLD} return { show, updateDots };`);
  const old = make($, {}, new Set(), () => {}, () => {}, () => {});
  for (const name of ['agents', 'chat', 'activity', 'agents']) assert.doesNotThrow(() => old.show(name), `old show('${name}') on the new page`);
  assert.ok(ids.has('tab-activity') && ids.has('act-unread'), 'the ids the old script needs are on the page');
});
