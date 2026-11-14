'use strict';
// The wake phrase standby on the two chat pages: the local-recognizer check, the call deps (wake, chime), the standby text,
// the four settings controls in each page's voice panel, and the display's "Waiting for ..." line.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const VW = require('../lib/ui-voice');
const CD = require('../lib/ui-call-display');

const PAGES = [
  { name: 'desktop', js: read('app.js'), html: null, prefs: 'voicePrefsNow', stateText: /textContent\s*=\s*voiceCallStateText\(name,\s*phrase\)/ },
  { name: 'phone', js: read('mobile.js'), html: read('mobile.html'), prefs: 'voicePrefsNow', stateText: /textContent\s*=\s*voiceCallStateText\(name,\s*phrase\)/ },
];

function extract(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}

// The page's two functions in a sandbox with the page's own state names.
function sandbox(page, world) {
  const body = `const AGENTS = world.agents; const agents = world.agents; let voiceStatus = world.status;
    const agentByName = (n) => agents.find(a => a && a.name === n);
    const voicePrefsNow = () => world.prefs;
    const voiceWakeForAgent = VW.voiceWakeForAgent;
    ${extract(page.js, 'voiceWakeAllowed')}
    ${extract(page.js, 'voiceWakeNow')}
    return { voiceWakeAllowed, voiceWakeNow };`;
  return new Function('world', 'VW', body)(world, VW);
}
const READY = { enabled: true, ready: true, stt: { engine: 'local' } };
const worldOf = (o) => Object.assign({ status: READY, agents: [{ name: 'sam', display: 'Sam' }], prefs: { wake: { sam: { on: true, phrase: 'Hey Sam', quietMs: 45000 } } } }, o || {});

for (const page of PAGES) {
  test(`${page.name}: voiceWakeAllowed needs a ready local recognizer and an agent without a cloud engine; anything unknown is false`, () => {
    const allowed = (o) => sandbox(page, worldOf(o)).voiceWakeAllowed('sam');
    assert.strictEqual(allowed(), true);
    assert.strictEqual(allowed({ status: null }), false, 'status unknown');
    assert.strictEqual(allowed({ status: undefined }), false);
    assert.strictEqual(allowed({ status: {} }), false);
    assert.strictEqual(allowed({ status: { enabled: false, ready: true, stt: { engine: 'local' } } }), false, 'voice off');
    assert.strictEqual(allowed({ status: { enabled: true, ready: false, stt: { engine: 'local' } } }), false, 'not ready');
    assert.strictEqual(allowed({ status: { enabled: true, ready: true } }), false, 'no stt info');
    assert.strictEqual(allowed({ status: { enabled: true, ready: true, stt: { engine: 'cloud' } } }), false, 'hub engine is not local');
    assert.strictEqual(allowed({ agents: [] }), false, 'agent unknown');
    assert.strictEqual(allowed({ agents: [{ name: 'sam', voice: { stt: 'openai' } }] }), false, 'a cloud engine for this agent');
    assert.strictEqual(allowed({ agents: [{ name: 'sam', voice: { stt: 'local' } }] }), true);
    assert.strictEqual(allowed({ agents: [{ name: 'sam', voice: {} }] }), true);
    assert.strictEqual(allowed({ agents: [{ name: 'sam', voice: { stt: '' } }] }), true);
    assert.strictEqual(sandbox(page, worldOf()).voiceWakeAllowed(''), false);
    assert.strictEqual(sandbox(page, worldOf()).voiceWakeAllowed(undefined), false);
  });

  test(`${page.name}: voiceWakeNow gives { phrase, quietMs, local } when on with a phrase (local only when allowed), else null`, () => {
    const now = (o) => sandbox(page, worldOf(o)).voiceWakeNow('sam');
    assert.deepStrictEqual(now(), { phrase: 'Hey Sam', quietMs: 45000, local: true });
    assert.strictEqual(now({ prefs: { wake: { sam: { on: false, phrase: 'Hey Sam', quietMs: 20000 } } } }), null, 'off');
    assert.strictEqual(now({ prefs: {} }), null, 'no entry');
    assert.strictEqual(now({ prefs: { wake: { sam: { on: true, phrase: '', quietMs: 20000 } } } }), null, 'no phrase');
    assert.strictEqual(now({ prefs: { wake: { other: { on: true, phrase: 'Hey Sam', quietMs: 20000 } } } }), null, 'another agent only');
    const notLocal = { phrase: 'Hey Sam', quietMs: 45000, local: false };
    assert.deepStrictEqual(now({ agents: [{ name: 'sam', voice: { stt: 'google' } }] }), notLocal, 'cloud agent: on, but not local');
    assert.deepStrictEqual(now({ agents: [] }), notLocal, 'agent list empty (a failed reload): not local, never off');
    assert.deepStrictEqual(now({ status: null }), notLocal, 'status unknown');
    assert.deepStrictEqual(now({ status: { enabled: true, ready: true, stt: { engine: 'cloud' } } }), notLocal);
  });

  test(`${page.name}: the call deps carry wake and chime, and standby is painted with textContent`, () => {
    const s = page.js;
    const deps = s.slice(s.indexOf('function voiceCallDeps('));
    assert.ok(/wake:\s*\(\)\s*=>\s*voiceWakeNow\(agent\)/.test(deps.slice(0, 6000)), 'wake dep');
    assert.ok(/chime:\s*\(\)\s*=>\s*voiceWakeChime\(/.test(deps.slice(0, 6000)), 'chime dep');
    const chime = extract(s, 'voiceWakeChime');
    assert.ok(/voicePlayWakeChime\(/.test(chime) && /try\s*\{/.test(chime) && /catch/.test(chime), 'the chime never throws');
    const text = extract(s, 'voiceCallStateText');
    assert.ok(/Waiting for \\u201c|Waiting for “/.test(text), 'standby text');
    assert.ok(!/innerHTML/.test(text));
    assert.ok(/voiceCallStateText\(name, phrase\)/.test(deps) || /voiceCallStateText\(name, phrase\)/.test(s), 'the state painter gets the phrase');
    assert.ok(page.stateText.test(s), 'textContent paints it');
    assert.ok(/voiceDisplayHook\('setState', name, phrase\)/.test(s), 'the phrase goes on to the display');
    assert.ok(!/standby/.test(s.match(/const VOICE_CALL_STATE_TEXT = \{[^}]*\}/)[0]), 'nothing static for standby');
    const st = require('vm').runInNewContext(`(function(){ ${text}; return voiceCallStateText; })()`, { VOICE_CALL_STATE_TEXT: { listening: 'Listening' } });
    assert.strictEqual(st('standby', 'Hey Sam'), 'Waiting for “Hey Sam”');
    assert.strictEqual(st('listening', ''), 'Listening');
  });

  test(`${page.name}: the voice panel has the four wake controls, saves through voiceSavePrefs with a wake map and calls wakeChanged`, () => {
    const s = page.js;
    if (page.html === null) assert.ok(/voiceWakeRowsHtml\(chatId\)/.test(extract(s, 'voicePopHtml')), 'the pop includes the wake rows');
    const markup = page.html === null ? extract(s, 'voiceWakeRowsBuild') : page.html;
    for (const t of ['Wait for the wake phrase', 'Back to waiting after', 'maxlength="60"', 'Hey ',
      'The call stays up and answers only after the phrase. Keep the app open with the screen on; a hidden page still hangs up. Say “that’s all” to go back to waiting.',
      'Needs speech recognition on this computer; this agent uses a cloud recognizer or voice is off.']) {
      const hay = markup + s;
      assert.ok(hay.includes(t) || hay.includes(t.replace(/[“”’]/g, (c) => ({ '“': '\\u201c', '”': '\\u201d', '’': '\\u2019' })[c])), `has: ${t}`);
    }
    assert.ok(/type="checkbox" id="(vp-wake|\$\{id\(''\)\})"/.test(markup), 'checkbox');
    assert.ok(/type="text" id="(vp-wake-phrase|\$\{id\('-phrase'\)\})"/.test(markup), 'phrase input');
    assert.ok(/<select id="(vp-wake-quiet|\$\{id\('-quiet'\)\})"/.test(markup), 'quiet select');
    assert.ok(/VOICE_WAKE_QUIET_MS\.map/.test(s.slice(s.indexOf('function voiceWakeSave'))), 'options from the shared list');
    const save = extract(s, 'voiceWakeSave');
    assert.ok(/voiceCleanWakePhrase\(/.test(save), 'phrase cleaned');
    assert.ok(/Use 1 to 4 words, e\.g\. Hey /.test(save), 'hint');
    assert.ok(/voiceSavePrefs\([^)]*\{\s*wake\b/.test(save) || /voicePrefsSave\(\{\s*wake\b/.test(save), 'saved as a wake map');
    assert.ok(/\.\.\.\(?[^,}]*\.wake/.test(save), 'other agents\' entries kept');
    assert.ok(/wakeChanged\(\)/.test(save), 'a running call is told');
    assert.ok(/voiceWakeAllowed\(/.test(extract(s, 'voiceWakePaint')), 'the controls follow the recognizer check');
    assert.ok(/wakeChanged\(\)/.test(extract(s, 'voiceWakeRecheck')), 'a status / agent-list re-read tells the call');
  });

  test(`${page.name}: nothing is reached when the wake setting is off (deps.wake is null); the STT function never shows, logs or stores the text`, () => {
    const stt = extract(page.js, 'voiceCallStt');
    assert.ok(!/console\.|toast\(|hubToast\(|localStorage|sessionStorage|textContent|innerHTML/.test(stt.replace(/hubToast\(\s*['"][^'"]*['"]\s*\)/g, '').replace(/voiceBusyToast\(r\.status\)/g, '')), 'no display / log / store of recognized text');
  });
}

test('the wake text is not in the static state texts of the display fallback only: STATE_TEXT has standby: Waiting', () => {
  assert.strictEqual(CD.STATE_TEXT.standby, 'Waiting');
});

test('mapDisplayState: standby is the resting state', () => {
  assert.strictEqual(CD.mapDisplayState('standby', {}), 'idle');
  assert.strictEqual(CD.mapDisplayState('standby', { audio: true, hello: true }), 'idle');
});

// ── the display: the status line ──
function displayWorld() {
  const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.style = { setProperty() {} }; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = this.children.indexOf(ref); c.parentNode = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    addEventListener() {}
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    focus() {}
    all() { return this.children.flatMap(c => [c, ...c.all()]); }
    querySelectorAll() { return []; }
  }
  const doc = { activeElement: null, createElement: (t) => new El(t), body: new El('body') };
  const orbs = [];
  const orb = () => { const p = { calls: [], ready: Promise.resolve() }; for (const n of ['setState', 'setAnalyser', 'setMicLevel', 'speechEvent', 'setLevel', 'thinkingPulse', 'cancelReaction']) p[n] = (...a) => { p.calls.push([n, ...a]); }; p.react = (m) => { p.calls.push(['react', m]); return true; }; p.destroy = () => {}; orbs.push(p); return p; };
  const display = CD.createCallDisplay({
    window: { document: doc }, document: doc, storage: { getItem: () => JSON.stringify({ choice: 'orb', captions: true }), setItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ packs: [] }) }), setTimeout: () => 1, clearTimeout() {},
    agentDefault: () => 'none', onTalk() {}, onHangUp() {}, onChange() {}, createVoiceOrb: orb, createFacePlayer: () => { throw new Error('no pack'); },
  });
  const status = () => doc.body.all().filter(n => (' ' + n.className + ' ').includes(' ucd-status '))[0];
  return { display, status, orbs, tick };
}

test('display: setState("standby", "Hey Sam") shows the waiting line, with no hello and no caption; without a phrase it says Waiting', async () => {
  const w = displayWorld();
  w.display.start(); await w.tick();
  assert.ok(w.status(), 'the view is up');
  w.display.setState('standby', 'Hey Sam');
  assert.strictEqual(w.status().textContent, 'Waiting for “Hey Sam”');
  assert.strictEqual(w.orbs[0].calls.filter(c => c[0] === 'react').length, 0, 'no hello reaction');
  assert.strictEqual(w.orbs[0].calls.filter(c => c[0] === 'setState').pop()[1], 'idle', 'the resting state');
  w.display.setState('standby');
  assert.strictEqual(w.status().textContent, 'Waiting');
  w.display.setState('listening');
  assert.strictEqual(w.status().textContent, 'Listening', 'the phrase does not stick');
  w.display.setState('standby', 'Hey Sam');
  w.display.setState('hearing');
  assert.strictEqual(w.status().textContent, 'Hearing you');
});

test('display: the phrase goes to textContent only (markup in it is text)', async () => {
  const w = displayWorld();
  w.display.start(); await w.tick();
  w.display.setState('standby', '<b>x</b>');
  assert.strictEqual(w.status().textContent, 'Waiting for “<b>x</b>”');
  assert.strictEqual(w.status().children.length, 0);
});

test('desktop: the wake rows are built disabled when the recognizer check says no', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  const at = src.indexOf('function voiceWakeRowsBuild(');
  const body = src.slice(at, src.indexOf('\n    function ', at + 10));
  assert.match(body, /const allowed = voiceWakeAllowed\(agent\), dis = allowed \? '' : ' disabled'/);
  assert.strictEqual((body.match(/\$\{dis\}/g) || []).length, 2, 'phrase and quiet select');
  assert.match(body, /\$\{w\.on \? '' : dis\}/, 'a ticked checkbox is never built disabled');
});

test('a ticked wake box can always be unticked, even when the recognizer check says no', () => {
  const fs = require('fs'), path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  assert.match(app, /el\.disabled = !ok && !\(el\.type === 'checkbox' && el\.checked\)/);
  assert.match(mob, /cb\.disabled = !ok && !w\.on;/);
});
