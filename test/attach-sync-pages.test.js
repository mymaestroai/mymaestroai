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
  assert.ok(h.status.some(x => x[2] === 'error' && x[1] === 'A picture took too long to prepare and was left out. Attach it again, or press Send to send without it.'));
  assert.strictEqual(s.input.readOnly, false, 'restored after the timeout');
  assert.strictEqual(s.btn.disabled, false);
});

const settled = (p) => Promise.race([p.then(() => 'done'), tick(15).then(() => 'waiting')]);

test('desktop: a voice send (sendOpts.voice) with a picture still decoding reads the box at once and does not wait', async () => {
  const h = deskPictures();
  const input = { value: '', style: {}, readOnly: false };
  const btn = { disabled: false };
  const sent = [];
  const { api } = load(APP, ['addImageToChat', 'waitForPreparingImages', 'sendInterjection', 'sendSoloMessage'], {
    ...h.base,
    document: Object.assign(canvasDoc(), { getElementById: (id) => (id === 'input-c1' ? input : id === 'send-c1' ? btn : null) }),
    clearPendingImages: () => { h.chat.pendingImages = []; }, appendMessageWithImages() { return 'x'; }, setMessageTime() {}, msgTimeLabel: () => 't',
    appendSystemNotice: () => ({}), skipInterjectOnce: new Set(), agentStatus: {},
    fetch: async (url, o) => { sent.push(JSON.parse(o.body)); return { json: async () => ({ success: true }) }; },
  });
  h.chat.status = 'thinking';   // the agent is working: the message goes into sendInterjection, which reads the box
  api.addImageToChat('c1', { name: 'slow.png' });   // still decoding
  // what voiceCallSend does: the spoken words in the box, the send, the draft put back right after
  input.value = 'spoken words';
  const run = api.sendSoloMessage('c1', 0, { voice: true, onSendResult() {} });
  input.value = 'my draft';
  assert.strictEqual(await settled(run), 'done', 'did not wait for the picture');
  assert.strictEqual(h.chat.sendWaiting, undefined, 'never waited');
  eq(sent, [{ agent: 'agent-a', message: 'spoken words' }]);
});

test('desktop: a second send while one waits returns at once; after both settle the box is not read-only and the button is restored', async () => {
  const h = deskPictures();
  const s = deskSend(h, { text: 'here' });
  s.api.addImageToChat('c1', { name: 'a.png' });
  const p1 = s.api.sendInterjection('c1');
  await tick(5);
  assert.strictEqual(s.input.readOnly, true);
  assert.strictEqual(await settled(s.api.sendInterjection('c1')), 'done', 'the second send did not wait');
  assert.strictEqual(s.input.readOnly, true, 'the first send still holds the lock');
  Object.assign(h.made[0], { width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 });
  h.made[0].onload();
  await p1;
  assert.strictEqual(s.input.readOnly, false);
  assert.strictEqual(s.btn.disabled, false);
  assert.strictEqual(s.sent.length, 1, 'only one message went');
});

test('desktop: after the cap a stuck picture is abandoned: the next send does not wait, and when it ends later nothing is added', async () => {
  const h = deskPictures();
  const s = deskSend(h, { text: 'here' });
  s.api.addImageToChat('c1', { name: 'huge.png' });   // stuck
  await s.api.sendInterjection('c1');   // the cap runs out
  eq(s.sent, []);
  assert.strictEqual(h.chat.imagesPreparing.size, 0, 'removed from the preparing set');
  const nStatus = h.status.length;
  assert.strictEqual(await settled(s.api.sendInterjection('c1')), 'done', 'the next send does not wait');
  eq(s.sent, [{ agent: 'agent-a', message: 'here' }]);
  Object.assign(h.made[0], { width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 });
  h.made[0].onload();
  await tick();
  eq(h.chat.pendingImages, [], 'nothing added');
  assert.strictEqual(h.status.length, nStatus, 'nothing shown');
  eq(h.revoked, ['blob:huge.png', 'blob:huge.png'], 'released at the cap, and again (harmless) when it ends');
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
  for (const [name, reads] of [['sendSoloMessage', 'const pendingImages = fallback'], ['sendInterjection', 'const imagesToSend = textOnly']]) {
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
    pendingImages: [], imagesPreparing: new Set(), IMAGE_WAIT_MS: 60, Image: FakeImage, draftGen: 0, sendWaiting: false,
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
  assert.ok(h.toasts.includes('A picture took too long to prepare and was left out. Attach it again, or press Send to send without it.'));
  assert.strictEqual(h.input.readOnly, false, 'restored after the timeout');
  assert.strictEqual(h.btn.disabled, false);
});

test('phone: a second send while one waits returns at once; after both settle the box is not read-only and the button is restored', async () => {
  const h = phonePictures();
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'a.png' });
  const p1 = s.api.sendMessage();
  await tick(5);
  assert.strictEqual(h.input.readOnly, true);
  assert.strictEqual(await settled(s.api.sendMessage()), 'done', 'the second send did not wait');
  assert.strictEqual(h.input.readOnly, true, 'the first send still holds the lock');
  Object.assign(h.made[0], { width: 10, height: 10 });
  h.made[0].onload();
  await p1;
  assert.strictEqual(h.input.readOnly, false);
  assert.strictEqual(h.btn.disabled, false);
  assert.strictEqual(s.seen.length, 1, 'only one send went on');
});

test('phone: after the cap a stuck picture is abandoned: the next send does not wait, and when it ends later nothing is added', async () => {
  const h = phonePictures();
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'huge.png' });   // stuck
  await s.api.sendMessage();   // the cap runs out
  eq(s.seen, []);
  assert.strictEqual(h.ctx.imagesPreparing.size, 0, 'removed from the preparing set');
  const nToasts = h.toasts.length;
  assert.strictEqual(await settled(s.api.sendMessage()), 'done', 'the next send does not wait');
  eq(s.seen, [{ images: [], text: 'here' }]);
  Object.assign(h.made[0], { width: 10, height: 10 });
  h.made[0].onload();
  await tick();
  eq(s.ctx.pendingImages, [], 'nothing added');
  assert.strictEqual(h.toasts.length, nToasts, 'nothing shown');
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

test('phone addImageFile: a decode that finishes after A -> B -> A is not added and toasts', async () => {
  const h = phonePictures();
  const { api, ctx } = load(MOBILE, ['addImageFile'], h.ctx);
  api.addImageFile({ name: 'a.png' });
  ctx.draftGen++;   // openChat(B)
  ctx.draftGen++;   // openChat(A): the same chat as the picture was attached in, but another draft
  Object.assign(h.made[0], { width: 10, height: 10 });
  h.made[0].onload();
  await tick();
  eq(ctx.pendingImages, []);
  assert.ok(h.toasts.includes('The picture was not added because you switched chats.'));
  assert.strictEqual(ctx.imagesPreparing.size, 0);
});

test('phone send that waited across A -> B -> A: not sent, toast', async () => {
  const h = phonePictures();
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'a.png' });
  const p = s.api.sendMessage();
  await tick(5);
  s.ctx.draftGen++;   // openChat(B)
  s.ctx.draftGen++;   // openChat(A)
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
  assert.match(fnSource(MOBILE, 'sendMessage'), /if \(!fallback && imagesPreparing\.size\) \{[^}]*await waitForPreparingImages\(\);/);
});

test('service worker: version bumped to v78', () => {
  assert.match(SW, /const VERSION = 'hub-mobile-v95';/);
});

// ── round 3: a wait abandons only what it waited for; a voice send never takes the waiting message's pictures; the flag is set in the try ──

const SIZE = { width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 };

test('desktop wait timeout: a picture attached during the wait is refused (no job); at the cap the old job is abandoned; a picture attached after it is added', async () => {
  const h = deskPictures();
  const s = deskSend(h, { text: 'here' });
  s.api.addImageToChat('c1', { name: 'old.png' });   // stuck
  const p = s.api.sendInterjection('c1');
  await tick(5);
  s.api.addImageToChat('c1', { name: 'late.png' });   // attached during the wait: refused
  assert.strictEqual(h.made.length, 1, 'no second picture was started');
  assert.ok(h.status.some(x => x[2] === 'error' && x[1] === 'A message is waiting for its pictures. Add this picture after it sends.'));
  await p;   // the cap runs out
  eq(s.sent, []);
  assert.strictEqual(h.chat.imagesPreparing.size, 0);
  s.api.addImageToChat('c1', { name: 'after.png' });   // after the wait: accepted
  assert.strictEqual([...h.chat.imagesPreparing][0].url, 'blob:after.png');
  assert.strictEqual([...h.chat.imagesPreparing][0].abandoned, false);
  Object.assign(h.made[1], SIZE);
  h.made[1].onload();
  await tick();
  eq(h.chat.pendingImages, ['data:image/jpeg;base64,AAAA']);
  assert.strictEqual(h.chat.imagesPreparing.size, 0);
  assert.ok(h.revoked.includes('blob:after.png'));
});

test('desktop wait timeout: an abandoned job\'s object URL is revoked at the timeout, even if its image never loads', async () => {
  const h = deskPictures();
  const s = deskSend(h, { text: 'here' });
  s.api.addImageToChat('c1', { name: 'huge.png' });   // never loads or errors
  await s.api.sendInterjection('c1');
  eq(h.revoked, ['blob:huge.png']);
});

function deskVoice(h) {
  const input = { value: '', style: {}, readOnly: false };
  const btn = { disabled: false };
  const sent = [];
  const { api } = load(APP, ['addImageToChat', 'waitForPreparingImages', 'sendInterjection', 'sendSoloMessage'], {
    ...h.base,
    document: Object.assign(canvasDoc(), { getElementById: (id) => (id === 'input-c1' ? input : id === 'send-c1' ? btn : null) }),
    clearPendingImages: () => { h.chat.pendingImages = []; }, appendMessageWithImages() { return 'x'; }, setMessageTime() {}, msgTimeLabel: () => 't',
    appendSystemNotice: () => ({}), skipInterjectOnce: new Set(), agentStatus: {},
    fetch: async (url, o) => { sent.push(JSON.parse(o.body)); return { json: async () => ({ success: true }) }; },
  });
  return { api, input, sent };
}

test('desktop: while chat.sendWaiting, a voice sendSoloMessage sends only the box text and leaves pendingImages unchanged', async () => {
  const h = deskPictures();
  const v = deskVoice(h);
  h.chat.status = 'thinking';   // goes through sendSoloMessage into sendInterjection (the request body is what is asserted)
  h.chat.pendingImages = ['data:image/jpeg;base64,WAITING'];
  h.chat.sendWaiting = true;   // a typed message is waiting for its pictures
  v.input.value = 'spoken words';
  await v.api.sendSoloMessage('c1', 0, { voice: true, onSendResult() {} });
  eq(v.sent, [{ agent: 'agent-a', message: 'spoken words' }], 'no images key');
  eq(h.chat.pendingImages, ['data:image/jpeg;base64,WAITING']);
  assert.strictEqual(h.chat.sendWaiting, true, 'the waiting send keeps its lock');
});

test('desktop: while chat.sendWaiting, a voice sendInterjection sends only the box text and does not clear the pending pictures', async () => {
  const h = deskPictures();
  const v = deskVoice(h);
  h.chat.pendingImages = ['data:image/jpeg;base64,WAITING'];
  h.chat.sendWaiting = true;
  v.input.value = 'spoken words';
  await v.api.sendInterjection('c1', { voice: true });
  eq(v.sent, [{ agent: 'agent-a', message: 'spoken words' }]);
  eq(h.chat.pendingImages, ['data:image/jpeg;base64,WAITING']);
});

test('desktop: sendWaiting is set inside the try: if chatFileStatus throws at the start of the wait, the flag is false and the box/button are restored', async () => {
  const h = deskPictures();
  const s = deskSend(h, { text: 'here' });
  s.api.addImageToChat('c1', { name: 'a.png' });
  const { api } = load(APP, ['waitForPreparingImages'], {
    ...h.base,
    document: Object.assign(canvasDoc(), { getElementById: (id) => (id === 'input-c1' ? s.input : id === 'send-c1' ? s.btn : null) }),
    chatFileStatus: () => { throw new Error('boom'); },
  });
  await assert.rejects(() => api.waitForPreparingImages('c1'), /boom/);
  assert.strictEqual(h.chat.sendWaiting, false);
  assert.strictEqual(s.input.readOnly, false);
  assert.strictEqual(s.btn.disabled, false);
});

test('phone: releaseSendWait() (openChat on a switch) ends the wait at once: false, no "took too long" toast, box/button restored, no job abandoned', async () => {
  const h = phonePictures();
  h.ctx.releaseSendWait = null;
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'a.png' });   // stuck
  const t0 = Date.now();
  const p = s.api.waitForPreparingImages();
  await tick(5);
  assert.strictEqual(h.input.readOnly, true);
  assert.strictEqual(typeof s.ctx.releaseSendWait, 'function');
  s.ctx.releaseSendWait();
  assert.strictEqual(await p, false);
  assert.ok(Date.now() - t0 < 50, 'ended before the cap');
  assert.ok(!h.toasts.some(t => /took too long/.test(t)));
  assert.strictEqual(h.input.readOnly, false);
  assert.strictEqual(h.btn.disabled, false);
  assert.strictEqual(s.ctx.sendWaiting, false);
  assert.strictEqual(s.ctx.releaseSendWait, null);
  assert.strictEqual(h.ctx.imagesPreparing.size, 1, 'the job is still preparing');
  assert.strictEqual([...h.ctx.imagesPreparing][0].abandoned, false);
  eq(h.revoked, []);
});

test('phone sendMessage: a switch during the wait (draftGen bumped, releaseSendWait) toasts "Not sent: you switched chats." and sends nothing', async () => {
  const h = phonePictures();
  h.ctx.releaseSendWait = null;
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'a.png' });
  const p = s.api.sendMessage();
  await tick(5);
  s.ctx.draftGen++;   // openChat: draftGen++ then releaseSendWait()
  s.ctx.releaseSendWait();
  await p;
  eq(s.seen, []);
  assert.ok(h.toasts.includes('Not sent: you switched chats.'));
  assert.ok(!h.toasts.some(t => /took too long/.test(t)));
  assert.strictEqual(h.input.readOnly, false);
  assert.strictEqual(h.btn.disabled, false);
});

test('phone wait timeout: a picture attached during the wait is refused (no job); at the cap the old job is abandoned and its URL revoked; a picture attached after is added', async () => {
  const h = phonePictures();
  h.ctx.releaseSendWait = null;
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'old.png' });   // stuck
  const p = s.api.sendMessage();
  await tick(5);
  s.api.addImageFile({ name: 'late.png' });   // attached during the wait: refused
  assert.strictEqual(h.made.length, 1, 'no second picture was started');
  assert.ok(h.toasts.includes('A message is waiting for its pictures. Add this picture after it sends.'));
  await p;   // the cap runs out
  eq(s.seen, []);
  eq(h.revoked, ['blob:old.png']);
  assert.strictEqual(h.ctx.imagesPreparing.size, 0);
  s.api.addImageFile({ name: 'after.png' });   // after the wait: accepted
  assert.strictEqual(h.ctx.imagesPreparing.size, 1);
  assert.strictEqual([...h.ctx.imagesPreparing][0].url, 'blob:after.png');
  Object.assign(h.made[1], { width: 10, height: 10 });
  h.made[1].onload();
  await tick();
  eq(s.ctx.pendingImages, ['data:image/jpeg;base64,AAAA']);
});

// ── round 4: no picture is added while a message waits for its pictures; a switch retires the old draft's jobs; a typed send keeps its own voice flag ──

const WAIT_WORDS = 'A message is waiting for its pictures. Add this picture after it sends.';

test('desktop addImageToChat: while chat.sendWaiting, no job and no picture are added and the waiting message is shown as an error', () => {
  const h = deskPictures();
  h.chat.sendWaiting = true;
  const { api } = load(APP, ['addImageToChat'], h.base);
  api.addImageToChat('c1', { name: 'a.png' });
  eq(h.status, [['c1', WAIT_WORDS, 'error']]);
  assert.ok(!h.chat.imagesPreparing || h.chat.imagesPreparing.size === 0, 'no job');
  eq(h.chat.pendingImages, []);
  assert.strictEqual(h.made.length, 0, 'no picture was started');
  eq(h.revoked, []);
});

test('phone addImageFile: while sendWaiting, no job and no picture are added and the same words are toasted', () => {
  const h = phonePictures();
  h.ctx.sendWaiting = true;
  const { api, ctx } = load(MOBILE, ['addImageFile'], h.ctx);
  api.addImageFile({ name: 'a.png' });
  eq(h.toasts, [WAIT_WORDS]);
  assert.strictEqual(ctx.imagesPreparing.size, 0);
  eq(ctx.pendingImages, []);
  assert.strictEqual(h.made.length, 0);
});

test('phone openChat retire step: a stuck job of the old draft is abandoned, removed and its URL revoked; then a text-only send does not wait', async () => {
  const h = phonePictures();
  h.ctx.releaseSendWait = null;
  const s = phoneSend(h, 'here');
  s.api.addImageFile({ name: 'old.png' });   // stuck, from the old draft
  assert.strictEqual(h.ctx.imagesPreparing.size, 1);
  const job = [...h.ctx.imagesPreparing][0];
  // exactly the retire lines of openChat, run in the same context
  const body = fnSource(MOBILE, 'openChat');
  const from = body.indexOf('pendingImages = [];');
  const to = body.indexOf('if (releaseSendWait) releaseSendWait();') + 'if (releaseSendWait) releaseSendWait();'.length;
  assert.ok(from > 0 && to > from, 'the retire lines are in openChat');
  assert.match(body.slice(from, to), /draftGen\+\+;[\s\S]*imagesPreparing[\s\S]*abandoned = true/, 'the slice holds draftGen++ and the retire loop');
  vm.runInContext(body.slice(from, to), s.ctx);
  assert.strictEqual(h.ctx.imagesPreparing.size, 0, 'the preparing set is empty');
  assert.strictEqual(job.abandoned, true);
  eq(h.revoked, ['blob:old.png']);
  assert.strictEqual(s.ctx.draftGen, 1);
  h.toasts.length = 0;
  await s.api.sendMessage();
  assert.ok(!h.toasts.includes('Adding the picture…'), 'did not wait');
  eq(s.seen, [{ images: [], text: 'here' }]);
});

test('phone openChat: the retire loop sits after draftGen++ and before releaseSendWait (source order)', () => {
  const body = fnSource(MOBILE, 'openChat');
  const g = body.indexOf('draftGen++;');
  const r = body.indexOf('for (const job of imagesPreparing)');
  const w = body.indexOf('if (releaseSendWait) releaseSendWait();');
  assert.ok(g > 0 && g < r && r < w);
});

test('desktop sendSoloMessage: a typed send keeps its own voice flag when chat.voiceSend is set to true during its picture wait (request body has no voice)', async () => {
  const h = deskPictures();
  const input = { value: 'typed words', style: {}, readOnly: false, placeholder: '' };
  const btn = { disabled: false };
  const bodies = [];
  const el = (id) => (id === 'input-c1' ? input : id === 'send-c1' ? btn : null);
  const { api } = load(APP, ['addImageToChat', 'waitForPreparingImages', 'sendSoloMessage'], {
    ...h.base,
    AbortController, window: {},
    document: Object.assign(canvasDoc(), { getElementById: el }),
    clearPendingImages: () => { h.chat.pendingImages = []; }, appendMessageWithImages() {}, setMessageTime() {}, msgTimeLabel: () => 't',
    appendSystemNotice: () => ({}), skipInterjectOnce: new Set(), agentStatus: {}, tzSentAt: 0, zoneHeader: () => ({}),
    setStatus() {}, setAgentStatus() {}, startToolTracker() {}, appendMessage: () => 'm1', elapsedLabel: () => '',
    voiceFacePackBody: () => ({ face: 1 }),
    fetch: async (url, o) => { bodies.push(JSON.parse(o.body)); throw new Error('stop after the request is built'); },
  });
  h.chat.status = 'idle'; h.chat.messages = [];
  api.addImageToChat('c1', { name: 'a.png' });   // still decoding: the send waits
  const run = api.sendSoloMessage('c1', 0, null).catch(() => {});
  await tick(5);
  assert.strictEqual(h.chat.sendWaiting, true, 'waiting for the picture');
  h.chat.voiceSend = true;   // a voice send made during the wait
  Object.assign(h.made[0], SIZE);
  h.made[0].onload();
  await run;
  assert.strictEqual(bodies.length, 1, 'the request was built');
  assert.strictEqual(bodies[0].message, 'typed words');
  assert.ok(!('voice' in bodies[0]), 'no voice: true');
  assert.ok(!('face' in bodies[0]), 'no voice face pack either');
});

test('desktop sendSoloMessage (source check): the request body and the 409 branch read the local voiceSend, not chat.voiceSend', () => {
  const body = fnSource(APP, 'sendSoloMessage');
  assert.match(body, /const voiceSend = retryCount \? !!chat\.voiceSend : !!\(sendOpts && sendOpts\.voice\);/);
  assert.match(body, /\.\.\.\(voiceSend \? \{ voice: true \} : \{\}\)/);
  assert.match(body, /\.\.\.\(voiceSend && typeof voiceFacePackBody/);
  const b409 = body.slice(body.indexOf('response.status === 409'));
  assert.match(b409.slice(0, b409.indexOf('notify(Object.assign')), /if \(voiceSend\) \{/);
  assert.match(body, /if \(voiceSend && typeof voiceLinkOwner/);
  // chat.voiceSend is only written once at the top and read for a retry
  assert.strictEqual((body.match(/chat\.voiceSend/g) || []).length, 2);
});
