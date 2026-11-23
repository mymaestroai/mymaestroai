'use strict';
// A turn's pictures on the person's other devices, and a picture never lost on send (both pages).
// Functions are cut out of app.js / mobile.js by name and run with stub document / fetch.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const APP = read('app.js');
const MOBILE = read('mobile.js');
const SW = read('sw.js');
const eq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

function fnSource(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in the page`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const load = (src, names, ctx = {}) => {
  const c = vm.createContext({
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'), TextEncoder, Promise, Set, Array, setTimeout, clearTimeout, ...ctx,
  });
  vm.runInContext(names.map(n => fnSource(src, n)).join('\n') + `\nthis.__fns = { ${names.join(', ')} };`, c);
  return { api: c.__fns, ctx: c };
};
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const enc = (p) => '/api/image/' + Buffer.from(p).toString('base64');
const IMG = '/tmp/x/data/uploads/a.jpg';

// A fake Image: the test settles it by hand (onload / onerror), like the browser would later.
function fakeImages() {
  const made = [];
  class FakeImage { constructor() { made.push(this); } set src(v) { this._src = v; } get src() { return this._src; } }
  return { FakeImage, made };
}
const canvasDoc = () => ({ createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,AAAA' }) });

// ── desktop: the turn's pictures drawn under the person's line ───────────────────────────────────────────────

function deskTurnStart(ev) {
  const drawn = [];   // [id, html] of insertAdjacentHTML calls
  const els = {};
  const elFor = (id) => (els[id] = els[id] || { id, insertAdjacentHTML: (where, html) => drawn.push([id, where, html]) });
  let n = 0;
  const chat = { id: 'c1', agent: 'agent-a', messages: [], historyLoaded: Promise.resolve(), status: 'idle' };
  const { api, ctx } = load(APP, ['savedImageUrls', 'onHubTurnStart'], {
    activeTurnStart() {}, openTurns: {}, busyRun: {}, chatViewIsHubOrigin: () => false, hubTurns: {}, setAgentLive() {}, hubOriginLabel: () => 'Another device',
    findSoloChat: () => chat, HUB_AUTO_OPEN: new Set(), AGENTS: [], chats: { c1: chat }, foldSamePrompt: () => false, chatViewGet: () => 'all',
    localStorage: {}, foldAutoOn: () => false, autoKindOfOrigin: () => null,
    appendMessage: (cid, role) => `m${++n}-${role}`, setMessageTime() {}, msgTimeLabel: () => 't', appendSystemNotice() {}, hubTurnTime: () => 't',
    hubTurnCards: {}, hubForOwnerPending: {}, busyCardKeepLast() {}, busyCardRefresh() {}, catchUpTurn() {}, setStatus() {}, markTabUnread() {},
    turnTrack: () => ({ items: new Map() }), turnActivityApply() {}, paintTurn() {},
    imageGalleryHtml: (urls, style) => `<gallery style="${style}">${urls.join(',')}</gallery>`,
    document: { getElementById: (id) => elFor(id) },
  });
  return api.onHubTurnStart(ev).then(() => ({ drawn, chat }));
}
const baseEv = { turnId: 't1', agent: 'agent-a', origin: { kind: 'user' }, startedAt: '2026-11-23T12:00:00Z', message: 'look at this' };

test('desktop onHubTurnStart: a turn from another device with pictures draws the gallery under the person\'s line', async () => {
  const { drawn, chat } = await deskTurnStart({ ...baseEv, images: [IMG] });
  assert.strictEqual(drawn.length, 1);
  assert.strictEqual(drawn[0][0], 'm1-user', 'under the user line, not the reply');
  assert.strictEqual(drawn[0][1], 'beforeend');
  assert.strictEqual(drawn[0][2], `<gallery style="max-height:200px;">${enc(IMG)}</gallery>`);
  assert.strictEqual(chat.messages.length, 1);
});

test('desktop onHubTurnStart: no pictures (absent or empty), nothing extra is drawn', async () => {
  assert.strictEqual((await deskTurnStart({ ...baseEv })).drawn.length, 0);
  assert.strictEqual((await deskTurnStart({ ...baseEv, images: [] })).drawn.length, 0);
});

// ── desktop: a picture is never lost on send ────────────────────────────────────────────────────────────────

function deskPictures() {
  const status = [];   // [chatId, text, kind]
  const revoked = [];
  const { FakeImage, made } = fakeImages();
  const chat = { id: 'c1', agent: 'agent-a', pendingImages: [] };
  const base = {
    chats: { c1: chat }, Image: FakeImage, URL: { createObjectURL: (f) => `blob:${f.name}`, revokeObjectURL: (u) => revoked.push(u) },
    document: Object.assign(canvasDoc(), { getElementById: () => null }), console: { log() {} },
    chatFileStatus: (id, text, kind) => status.push([id, text, kind]), renderImagePreviews() {}, IMAGE_WAIT_MS: 60,
  };
  return { chat, status, revoked, made, base };
}

test('desktop addImageToChat: a picture that cannot be read shows the message, is not added, and its link is released', async () => {
  const h = deskPictures();
  const { api } = load(APP, ['addImageToChat', 'waitForPreparingImages'], h.base);
  api.addImageToChat('c1', { name: 'broken.heic' });
  assert.strictEqual(h.chat.imagesPreparing.size, 1);
  h.made[0].onerror();
  await tick();
  eq(h.status, [['c1', 'Could not read that picture (broken.heic). Try a PNG or JPEG, or a screenshot of it.', 'error']]);
  eq(h.revoked, ['blob:broken.heic']);
  eq(h.chat.pendingImages, []);
  assert.strictEqual(h.chat.imagesPreparing.size, 0, 'no longer preparing');
});

test('desktop addImageToChat: a picture that loads is added and its link is released (it leaked before)', async () => {
  const h = deskPictures();
  const { api } = load(APP, ['addImageToChat'], h.base);
  api.addImageToChat('c1', { name: 'a.png' });
  Object.assign(h.made[0], { width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 });
  h.made[0].onload();
  await tick();
  eq(h.chat.pendingImages, ['data:image/jpeg;base64,AAAA']);
  eq(h.revoked, ['blob:a.png']);
  assert.strictEqual(h.chat.imagesPreparing.size, 0);
});

function deskSend(h, { text = '' } = {}) {
  const input = { value: text, style: {}, readOnly: false };
  const btn = { disabled: false };
  const sent = [];
  const { api } = load(APP, ['addImageToChat', 'waitForPreparingImages', 'sendInterjection'], {
    ...h.base,
    document: Object.assign(canvasDoc(), { getElementById: (id) => (id === 'input-c1' ? input : id === 'send-c1' ? btn : null) }),
    clearPendingImages: () => { h.chat.pendingImages = []; }, appendMessageWithImages() { return 'x'; }, setMessageTime() {}, msgTimeLabel: () => 't',
    appendSystemNotice: () => ({}),
    fetch: async (url, o) => { sent.push(JSON.parse(o.body)); return { json: async () => ({ success: true }) }; },
  });
  return { api, input, btn, sent };
}

test('desktop send right after attaching: waits for the picture, shows "Adding the picture…", and sends it', async () => {
  const h = deskPictures();
  const s = deskSend(h, { text: 'here' });
  s.api.addImageToChat('c1', { name: 'a.png' });
  const p = s.api.sendInterjection('c1');
  await tick(5);
  assert.strictEqual(s.sent.length, 0, 'still waiting');
  assert.ok(h.status.some(x => x[1] === 'Adding the picture…'));
  Object.assign(h.made[0], { width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 });
  h.made[0].onload();
  await p;
  eq(s.sent, [{ agent: 'agent-a', message: 'here', images: ['data:image/jpeg;base64,AAAA'] }]);
});

test('desktop send while a picture fails to decode: the message is shown, the picture is not sent', async () => {
  const h = deskPictures();
  const s = deskSend(h, { text: 'here' });
  s.api.addImageToChat('c1', { name: 'bad.bmp' });
  const p = s.api.sendInterjection('c1');
  await tick(5);
  h.made[0].onerror();
  await p;
  assert.ok(h.status.some(x => x[2] === 'error' && /Could not read that picture \(bad\.bmp\)/.test(x[1])));
  eq(s.sent, [{ agent: 'agent-a', message: 'here' }], 'text only, no images key');
});

test('desktop send gives up waiting for a stuck picture after the cap: nothing is sent, the draft stays, the message is shown', async () => {
  const h = deskPictures();
  const s = deskSend(h, { text: 'here' });
  s.api.addImageToChat('c1', { name: 'huge.png' });   // never settles
  const t0 = Date.now();
  await s.api.sendInterjection('c1');
  assert.ok(Date.now() - t0 >= 50 && Date.now() - t0 < 1000, 'waited about the cap, not forever');
  eq(s.sent, []);
  assert.strictEqual(s.input.value, 'here');
  assert.ok(h.status.some(x => x[2] === 'error' && x[1] === 'The picture is still being prepared. Press Send again in a moment.'));
  assert.strictEqual(s.input.readOnly, false, 'restored after the timeout');
  assert.strictEqual(s.btn.disabled, false);
});

test('desktop send: the box is readOnly and the button disabled during the wait, restored after (a button disabled before stays so)', async () => {
  const h = deskPictures();
  const s = deskSend(h, { text: 'here' });
  s.api.addImageToChat('c1', { name: 'a.png' });
  const p = s.api.sendInterjection('c1');
  await tick(5);
  assert.strictEqual(s.input.readOnly, true);
  assert.strictEqual(s.btn.disabled, true);
  Object.assign(h.made[0], { width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 });
  h.made[0].onload();
  await p;
  assert.strictEqual(s.input.readOnly, false);
  assert.strictEqual(s.btn.disabled, false);
  const h2 = deskPictures();
  const s2 = deskSend(h2, { text: 'x' });
  s2.btn.disabled = true;
  s2.api.addImageToChat('c1', { name: 'b.png' });
  const p2 = s2.api.sendInterjection('c1');
  await tick(5);
  h2.made[0].onerror();
  await p2;
  assert.strictEqual(s2.btn.disabled, true, 'was disabled for another reason');
});

test('desktop addImageToChat: a canvas that throws in toDataURL gives the error message and adds no picture', async () => {
  const h = deskPictures();
  h.base.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => { throw new Error('tainted'); } }), getElementById: () => null };
  const { api } = load(APP, ['addImageToChat'], h.base);
  api.addImageToChat('c1', { name: 'c.png' });
  Object.assign(h.made[0], { width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 });
  h.made[0].onload();
  await tick();
  eq(h.chat.pendingImages, []);
  eq(h.status, [['c1', 'Could not read that picture (c.png). Try a PNG or JPEG, or a screenshot of it.', 'error']]);
  assert.strictEqual(h.chat.imagesPreparing.size, 0, 'the promise settled');
});

test('desktop: sendSoloMessage and sendInterjection wait before they read the pictures', () => {
  for (const [name, reads] of [['sendSoloMessage', 'const pendingImages = fallback'], ['sendInterjection', 'const imagesToSend = [...(chat.pendingImages']]) {
    const body = fnSource(APP, name);
    const w = body.indexOf('await waitForPreparingImages(chatId)');
    assert.ok(w > 0, `${name} waits`);
    assert.ok(w < body.indexOf(reads), `${name} waits before reading the pictures`);
  }
});

// ── phone ───────────────────────────────────────────────────────────────────────────────────────────────────

test('phone onTurnStart: the turn\'s pictures go to the user bubble; without them an empty list', () => {
  const bubbles = [];
  const mk = (ev) => {
    const { api } = load(MOBILE, ['savedImageUrls', 'onTurnStart'], {
      activeTurnStart() {}, openTurns: {}, hubTurns: {}, setLive() {}, originLabel: () => 'x', noteTurnOrigin() {}, ownTurnFor: () => false,
      chatOpenFor: () => true, streams: new Map(), chatHistory: [], samePrompt: () => false, foldAutoOn: () => false, autoKindOfOrigin: () => null,
      addNote() {}, timeLabel: () => 't', addUserBubble: (t, imgs) => { bubbles.push([t, imgs]); return {}; }, setBubbleTime() {}, msgTimeLabel: () => 't',
      addAssistantBubble: () => { throw new Error('stop after the user line'); }, chatEl: () => ({ lastElementChild: null }),
    });
    try { api.onTurnStart(ev); } catch (e) { if (!/stop after/.test(e.message)) throw e; }
  };
  mk({ turnId: 't1', agent: 'agent-a', origin: { kind: 'user' }, startedAt: '2026-11-23T12:00:00Z', message: 'look', images: [IMG] });
  mk({ turnId: 't2', agent: 'agent-a', origin: { kind: 'user' }, startedAt: '2026-11-23T12:00:00Z', message: 'plain' });
  eq(bubbles, [['look', [enc(IMG)]], ['plain', []]]);
});

test('phone catchUpReattach: the turn\'s message is drawn with its pictures (source check: the full function needs the whole page)', () => {
  const body = fnSource(MOBILE, 'catchUpReattach');
  assert.match(body, /addUserBubble\(turn\.message, savedImageUrls\(turn\.images\)\)/);
});

test('phone savedImageUrls accepts undefined', () => {
  eq(load(MOBILE, ['savedImageUrls']).api.savedImageUrls(undefined), []);
});

function phonePictures() {
  const toasts = [];
  const revoked = [];
  const { FakeImage, made } = fakeImages();
  const input = { value: '', style: {}, blur() {}, readOnly: false };
  const btn = { disabled: false };
  const ctx = {
    pendingImages: [], imagesPreparing: new Set(), IMAGE_WAIT_MS: 60, Image: FakeImage,
    URL: { createObjectURL: (f) => `blob:${f.name}`, revokeObjectURL: (u) => revoked.push(u) },
    document: canvasDoc(), toast: (m) => toasts.push(m), renderPreviews() {},
    $: (id) => (id === 'msg-input' ? input : id === 'send-btn' ? btn : null), current: 'agent-a',
  };
  return { ctx, toasts, revoked, made, input, btn };
}

test('phone addImageFile: a picture that cannot be read shows the same words as the desktop and is not added', async () => {
  const h = phonePictures();
  const { api, ctx } = load(MOBILE, ['addImageFile', 'waitForPreparingImages'], h.ctx);
  api.addImageFile({ name: 'broken.heic' });
  assert.strictEqual(h.ctx.imagesPreparing.size, 1);
  h.made[0].onerror();
  await tick();
  eq(h.toasts, ['Could not read that picture (broken.heic). Try a PNG or JPEG, or a screenshot of it.']);
  eq(h.revoked, ['blob:broken.heic']);
  eq(ctx.pendingImages, []);
  assert.strictEqual(h.ctx.imagesPreparing.size, 0);
});

// sendMessage is cut out whole; the agent is made busy so it ends in a recorded sendInterjection, which sees what is in pendingImages by then.
function phoneSend(h, text) {
  const seen = [];
  const input = h.input;
  input.value = text;
  const { api, ctx } = load(MOBILE, ['addImageFile', 'waitForPreparingImages', 'sendMessage'], {
    ...h.ctx, isBusy: () => true, ownTurnFor: () => false, plusSheetShow() {},
    sendInterjection: async () => { seen.push({ images: [...ctx.pendingImages], text: input.value }); },
  });
  return { api, ctx, seen };
}

test('phone send right after attaching: waits for the picture (toast) and sends it', async () => {
  const h = phonePictures();
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'a.png' });
  const p = s.api.sendMessage();
  await tick(5);
  assert.strictEqual(s.seen.length, 0, 'still waiting');
  assert.ok(h.toasts.includes('Adding the picture…'));
  Object.assign(h.made[0], { width: 10, height: 10 });
  h.made[0].onload();
  await p;
  eq(s.seen, [{ images: ['data:image/jpeg;base64,AAAA'], text: 'here' }]);
});

test('phone send while a picture fails to decode: the message is shown and nothing is sent for it', async () => {
  const h = phonePictures();
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'bad.bmp' });
  const p = s.api.sendMessage();
  await tick(5);
  h.made[0].onerror();
  await p;
  assert.ok(h.toasts.some(t => /Could not read that picture \(bad\.bmp\)/.test(t)));
  eq(s.seen, [{ images: [], text: 'here' }]);
});

test('phone send gives up waiting for a stuck picture after the cap: nothing is sent, the draft stays, the message is shown', async () => {
  const h = phonePictures();
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'huge.png' });   // never settles
  const t0 = Date.now();
  await s.api.sendMessage();
  assert.ok(Date.now() - t0 >= 50 && Date.now() - t0 < 1000, 'waited about the cap, not forever');
  eq(s.seen, []);
  assert.strictEqual(h.input.value, 'here');
  assert.ok(h.toasts.includes('The picture is still being prepared. Press Send again in a moment.'));
  assert.strictEqual(h.input.readOnly, false, 'restored after the timeout');
  assert.strictEqual(h.btn.disabled, false);
});

test('phone send: the box is readOnly and the button disabled during the wait, restored after (a button disabled before stays so)', async () => {
  const h = phonePictures();
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'a.png' });
  const p = s.api.sendMessage();
  await tick(5);
  assert.strictEqual(h.input.readOnly, true);
  assert.strictEqual(h.btn.disabled, true);
  Object.assign(h.made[0], { width: 10, height: 10 });
  h.made[0].onload();
  await p;
  assert.strictEqual(h.input.readOnly, false);
  assert.strictEqual(h.btn.disabled, false);
  const h2 = phonePictures();
  h2.btn.disabled = true;
  const s2 = phoneSend(h2, 'x');
  s2.api.addImageFile({ name: 'b.png' });
  const p2 = s2.api.sendMessage();
  await tick(5);
  h2.made[0].onerror();
  await p2;
  assert.strictEqual(h2.btn.disabled, true, 'was disabled for another reason');
});

test('phone addImageFile: a decode that finishes after a chat switch is not added and toasts', async () => {
  const h = phonePictures();
  const { api, ctx } = load(MOBILE, ['addImageFile'], h.ctx);
  api.addImageFile({ name: 'a.png' });
  ctx.current = 'agent-b';
  Object.assign(h.made[0], { width: 10, height: 10 });
  h.made[0].onload();
  await tick();
  eq(ctx.pendingImages, []);
  assert.ok(h.toasts.includes('The picture was not added because you switched chats.'));
  assert.strictEqual(ctx.imagesPreparing.size, 0);
});

test('phone send that waited and finds the chat switched: not sent, toast', async () => {
  const h = phonePictures();
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'a.png' });
  const p = s.api.sendMessage();
  await tick(5);
  s.ctx.current = 'agent-b';
  h.made[0].onerror();
  await p;
  eq(s.seen, []);
  assert.ok(h.toasts.includes('Not sent: you switched chats.'));
});

test('phone addImageFile: a canvas that throws in toDataURL gives the error message and adds no picture', async () => {
  const h = phonePictures();
  h.ctx.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => { throw new Error('tainted'); } }) };
  const { api, ctx } = load(MOBILE, ['addImageFile'], h.ctx);
  api.addImageFile({ name: 'c.png' });
  Object.assign(h.made[0], { width: 10, height: 10 });
  h.made[0].onload();
  await tick();
  eq(ctx.pendingImages, []);
  assert.ok(h.toasts.includes('Could not read that picture (c.png). Try a PNG or JPEG, or a screenshot of it.'));
  assert.strictEqual(ctx.imagesPreparing.size, 0, 'the promise settled');
});

test('phone: a send with nothing preparing does not wait (no await before the composer is read)', () => {
  assert.match(fnSource(MOBILE, 'sendMessage'), /if \(!fallback && imagesPreparing\.size\) \{ if \(!\(await waitForPreparingImages\(\)\)\) return;/);
});

test('service worker: version bumped to v78', () => {
  assert.match(SW, /const VERSION = 'hub-mobile-v78';/);
});
