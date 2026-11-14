'use strict';
// Pictures in interjections (a message sent while the agent is mid-reply). The route tests are in
// interjection-history.test.js; this file holds the channel/stash/carry unit tests and the page tests.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// lib/ comes from a throwaway install, so uploads go to its data/uploads and nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('interjection-images-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const sdkInterject = L('sdk-interject');
const images = L('images');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
// Values made inside a page's vm context have that context's Array/Object, so they are compared as plain JSON.
const eq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
const next = (gen, ms = 300) => Promise.race([gen.next(), new Promise(r => setTimeout(() => r({ timeout: true }), ms))]);

// ── sdk-interject: block content, stash, carry ───────────────────────────────────────────────────────────────

test('sdk-interject: an item with pictures becomes a block-content user message (image blocks, then the text); one without stays a string', async () => {
  const saved = images.saveUploadedImage(PNG_URL);
  assert.ok(saved && saved.startsWith(path.join(ISO.data, 'uploads')), 'saved in the isolated install');
  const q = [{ message: 'look at this', ts: 't1', images: [saved] }, { message: 'and this is plain', ts: 't2' }];
  const ch = new sdkInterject.SdkInterjectionChannel({
    drain: () => q.splice(0), peek: () => q.length,
    contentFor: (ij, text) => [...images.imagesToAnthropicFormat(ij.images), { type: 'text', text }],
  });
  const gen = ch.stream('go');
  await next(gen);
  const withPic = (await next(gen)).value;
  assert.ok(Array.isArray(withPic.message.content), 'block content');
  assert.strictEqual(withPic.message.content.length, 2);
  assert.strictEqual(withPic.message.content[0].type, 'image');
  assert.strictEqual(withPic.message.content[0].source.media_type, 'image/png');
  assert.strictEqual(withPic.message.content[0].source.data, PNG_B64);
  eq(withPic.message.content[1], { type: 'text', text: sdkInterject.INTERJECTION_PREFIX + 'look at this' });
  const plain = (await next(gen)).value;
  assert.strictEqual(plain.message.content, sdkInterject.INTERJECTION_PREFIX + 'and this is plain', 'no pictures: the string as before');
  const rec = ch.ack(withPic.uuid);
  eq(rec.images, [saved], 'the ack returns the original item, pictures included');
  ch.close();
  eq(ch.undelivered().map(i => i.message), ['and this is plain'], 'undelivered keeps the original items');
  eq(ch.delivered().map(i => i.images), [[saved]]);
});

test('sdk-interject: without a content builder an item with pictures still goes as text (the file needs no image code)', async () => {
  const q = [{ message: 'hi', ts: 't', images: ['/x/a.png'] }];
  const ch = new sdkInterject.SdkInterjectionChannel({ drain: () => q.splice(0), peek: () => q.length });
  const gen = ch.stream('go');
  await next(gen);
  assert.strictEqual((await next(gen)).value.message.content, sdkInterject.INTERJECTION_PREFIX + 'hi');
  ch.close();
});

test('sdk-interject: stash and take keep images; carriedImages lists the paths once; the carried text names the pictures', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ij-img-')), 'pending.json');
  sdkInterject.stashUndelivered('agent_x', [
    { message: 'one', ts: 't1', images: ['/x/a.png', '/x/b.jpg'] },
    { message: '', ts: 't2', images: ['/x/a.png'] },
    { message: 'plain', ts: 't3' },
  ], f);
  eq(sdkInterject.peekUndelivered('agent_x', f).map(i => i.images), [['/x/a.png', '/x/b.jpg'], ['/x/a.png'], undefined]);
  const items = sdkInterject.takeUndelivered('agent_x', f);
  eq(items[0].images, ['/x/a.png', '/x/b.jpg'], 'kept through the stash file');
  eq(sdkInterject.carriedImages(items), ['/x/a.png', '/x/b.jpg']);
  const text = sdkInterject.formatCarried(items);
  assert.match(text, /\(t1\) one \[2 pictures attached/);
  assert.match(text, /\(t2\) \[1 picture attached/);
  assert.doesNotMatch(text.split('\n').find(l => l.includes('plain')), /picture/);
  eq(sdkInterject.carriedImages([{ message: 'x', ts: 't' }]), []);
});

// ── the pages ──────────────────────────────────────────────────────────────────────────────────────────────

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const APP = read('app.js');
const MOBILE = read('mobile.js');
// One named function out of a page's source, by brace matching (async kept).
function fnSource(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in the page`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const load = (src, names, ctx = {}) => { const c = vm.createContext({ btoa: (s) => Buffer.from(s, 'latin1').toString('base64'), ...ctx }); vm.runInContext(names.map(n => fnSource(src, n)).join('\n') + `\nthis.__fns = { ${names.join(', ')} };`, c); return { api: c.__fns, ctx: c }; };

test('pages: the old "Images cannot be interjected" toast is gone from both pages', () => {
  assert.doesNotMatch(MOBILE, /Images cannot be interjected/);
  assert.doesNotMatch(APP, /Images cannot be interjected/);
});

test('pages: a saved picture path is drawn from /api/image/<base64(path)> (both pages)', () => {
  const p = '/srv/data/uploads/abc123.png';
  const want = '/api/image/' + Buffer.from(p).toString('base64');
  eq(load(MOBILE, ['savedImageUrls']).api.savedImageUrls([p, '', null, 5]), [want]);
  eq(load(APP, ['savedImageUrls']).api.savedImageUrls([p, '', null, 5]), [want]);
  eq(load(MOBILE, ['savedImageUrls']).api.savedImageUrls(undefined), []);
});

function phoneHarness({ apiResult, pending = [PNG_URL], text = '' }) {
  const calls = { api: [], bubbles: [], toasts: [], sendMessage: [], notes: [] };
  const input = { value: text, style: {} };
  const ctx = {
    pendingImages: pending.slice(), current: 'agent_x', stick: false, streams: new Map(),
    $: () => input, saveDraft() {}, composerTypingPaint() {}, renderPreviews() {}, scrollChat() {}, setBubbleTime() {}, msgTimeLabel: () => 't',
    toast: (m) => calls.toasts.push(m), paintStatus() {}, setLive() {},
    addUserBubble: (t, imgs) => { calls.bubbles.push({ text: t, images: imgs }); return {}; },
    addNote: (t) => { const n = { textContent: t, classList: { add() {} } }; calls.notes.push(n); return n; },
    api: async (url, o) => { calls.api.push({ url, body: JSON.parse(o.body) }); return { json: async () => apiResult }; },
    sendMessage: async (f) => { calls.sendMessage.push(f); },
  };
  const { api, ctx: c } = load(MOBILE, ['sendInterjection'], ctx);
  return { send: () => api.sendInterjection('agent_x'), calls, input, ctx: c };
}

test('phone sendInterjection: pictures without text are sent with the interjection, cleared, and drawn in the bubble', async () => {
  const h = phoneHarness({ apiResult: { success: true } });
  await h.send();
  assert.strictEqual(h.calls.api.length, 1);
  assert.strictEqual(h.calls.api[0].url, '/api/chat/interject');
  eq(h.calls.api[0].body, { agent: 'agent_x', message: '', images: [PNG_URL] });
  eq(h.calls.bubbles, [{ text: '', images: [PNG_URL] }]);
  eq(h.ctx.pendingImages, [], 'the previews are cleared');
  eq(h.calls.toasts, [], 'no refusal toast');
});

test('phone sendInterjection: text plus pictures sends both; nothing at all sends nothing', async () => {
  const h = phoneHarness({ apiResult: { success: true }, text: 'look' });
  await h.send();
  eq(h.calls.api[0].body, { agent: 'agent_x', message: 'look', images: [PNG_URL] });
  const none = phoneHarness({ apiResult: { success: true }, pending: [] });
  await none.send();
  assert.strictEqual(none.calls.api.length, 0);
  const textOnly = phoneHarness({ apiResult: { success: true }, pending: [], text: 'plain' });
  await textOnly.send();
  eq(textOnly.calls.api[0].body, { agent: 'agent_x', message: 'plain' }, 'a text-only interjection has no images key');
});

test('phone sendInterjection: when the hub says the turn already ended, the normal send keeps the pictures', async () => {
  const h = phoneHarness({ apiResult: { success: false, error: 'Agent "agent_x" is not currently processing a request' }, text: 'late' });
  await h.send();
  assert.strictEqual(h.calls.sendMessage.length, 1);
  eq(h.calls.sendMessage[0].images, [PNG_URL]);
  assert.strictEqual(h.calls.sendMessage[0].text, 'late');
  // and sendMessage reads them from the fallback (not []): the line in the page
  assert.match(MOBILE, /const images = fallback \? \(fallback\.images \|\| \[\]\) : pendingImages\.slice\(\);/);
});

test('phone: history entries with images draw them in the bubble (an interjection and a normal message); live blocks draw them too', () => {
  const calls = [];
  const { api } = load(MOBILE, ['savedImageUrls', 'renderEntry'], {
    interjectionView: (m) => (m.interjection ? { text: 'words', emergency: false } : null),
    addUserBubble: (t, imgs) => { calls.push([t, imgs]); return {}; }, setBubbleTime() {}, addNote: () => ({ classList: { add() {} } }), originLabel: () => '', timeLabel: () => '',
  });
  api.renderEntry({ role: 'user', content: 'see', images: ['/d/u/a.png'] }, '');
  api.renderEntry({ role: 'user', content: '[OPERATOR INTERJECTION]: words', interjection: { id: 'ij-1' }, images: ['/d/u/b.png'] }, '');
  api.renderEntry({ role: 'user', content: 'no pictures' }, '');
  const enc = (p) => '/api/image/' + Buffer.from(p).toString('base64');
  eq(calls, [['see', [enc('/d/u/a.png')]], ['words', [enc('/d/u/b.png')]], ['no pictures', []]]);
  // the live turn's interjection block (the hub's turn item and the phone's own sent ones) carries and draws its pictures
  assert.match(MOBILE, /kind: 'ij', id: item\.id, text: String\(item\.message \|\| ''\), emergency: item\.priority === 'emergency', images: savedImageUrls\(item\.images\)/);
  assert.match(MOBILE, /for \(const src of b\.ij\.images \|\| \[\]\)/);
  assert.match(MOBILE, /images: x\.images \|\| \[\]/);
});

function deskHarness({ result, pending = [PNG_URL], text = '' }) {
  const calls = { fetch: [], messages: [], notices: [], solo: [], previews: 0 };
  const input = { value: text, style: {} };
  const chat = { agent: 'agent_x', pendingImages: pending.slice() };
  const ctx = {
    chats: { c1: chat }, skipInterjectOnce: new Set(),
    document: { getElementById: (id) => (id === 'input-c1' ? input : { id }) },
    clearPendingImages: (id) => { chat.pendingImages = []; },
    renderImagePreviews: () => { calls.previews++; },
    appendMessageWithImages: (id, role, content, imgs) => { calls.messages.push({ content, images: imgs }); return 'm1'; },
    setMessageTime() {}, msgTimeLabel: () => 't',
    appendSystemNotice: () => { const n = { textContent: '' }; calls.notices.push(n); return n; },
    fetch: async (url, o) => { calls.fetch.push({ url, body: JSON.parse(o.body) }); return { json: async () => result }; },
    sendSoloMessage: async (id) => { calls.solo.push({ id, value: input.value, images: chat.pendingImages.slice() }); },
  };
  const { api } = load(APP, ['sendInterjection'], ctx);
  return { send: () => api.sendInterjection('c1'), calls, chat, input };
}

test('desktop sendInterjection: pictures without text go with the interjection, are cleared, and drawn with the message', async () => {
  const h = deskHarness({ result: { success: true } });
  await h.send();
  eq(h.calls.fetch[0].body, { agent: 'agent_x', message: '', images: [PNG_URL] });
  assert.strictEqual(h.calls.fetch[0].url, '/api/chat/interject');
  eq(h.calls.messages, [{ content: '⚡ [Interjection]', images: [PNG_URL] }]);
  eq(h.chat.pendingImages, []);
  const plain = deskHarness({ result: { success: true }, pending: [], text: 'hi' });
  await plain.send();
  eq(plain.calls.fetch[0].body, { agent: 'agent_x', message: 'hi' });
  const nothing = deskHarness({ result: { success: true }, pending: [] });
  await nothing.send();
  assert.strictEqual(nothing.calls.fetch.length, 0);
});

test('desktop sendInterjection: the turn had already ended -> the normal send gets the text and the pictures back; a refusal returns the pictures', async () => {
  const ended = deskHarness({ result: { success: false, error: 'Agent "agent_x" is not currently processing a request' }, text: 'late' });
  await ended.send();
  eq(ended.calls.solo, [{ id: 'c1', value: 'late', images: [PNG_URL] }]);
  const refused = deskHarness({ result: { success: false, error: 'Interjection not sent: interjection[0]: data URL does not contain an image' } });
  await refused.send();
  eq(refused.chat.pendingImages, [PNG_URL], 'not sent: the pictures are back in the input');
  assert.match(refused.calls.notices[0].textContent, /Interjection failed: Interjection not sent/);
});

test('desktop: a message with pictures while the agent is busy goes as an interjection (not the normal send); history and the live block draw pictures', () => {
  assert.match(APP, /if \(\(content \|\| pendingImages\.length > 0\) && agentWorking && !skipInterjectOnce\.delete\(chatId\)\)/);
  assert.doesNotMatch(APP, /agentWorking && pendingImages\.length === 0/);
  assert.match(APP, /if \(!chat\.bounced409\) \{/, 'a 409 bounce delivers pictures too');
  // history: a user line with images draws them with the existing gallery code
  assert.match(APP, /msg\.role === 'user' && Array\.isArray\(msg\.images\) && msg\.images\.length[\s\S]{0,260}imageGalleryHtml\(savedImageUrls\(msg\.images\)/);
  // the live turn's interjection block
  assert.match(APP, /images: savedImageUrls\(item\.images\) \}, done: true/);
  assert.match(APP, /\$\{imageGalleryHtml\(ij\.images, 'max-height:200px;'\)\}<\/div>`;/);
  const t = { items: new Map() };
  const { api } = load(APP, ['savedImageUrls', 'turnActivityApply'], { turnWorkerUpsert() {} });
  assert.strictEqual(api.turnActivityApply('c1', t, { id: 'a1', kind: 'interjection', message: '', images: ['/d/u/a.png'], at: 3 }), 'interjection');
  eq([...t.items.values()][0].ij.images, ['/api/image/' + Buffer.from('/d/u/a.png').toString('base64')]);
});
