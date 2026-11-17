'use strict';
// lib/share-links: the store, the file check, the download header, the pages, the settings and the limiter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SL = require('../lib/share-links');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'share-links-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function rig(t, extra = {}) {
  const dir = tmp(t);
  const clock = { t: 1_800_000_000_000 };
  const file = path.join(dir, 'data', 'share-links.json');
  const logs = [];
  const make = () => SL.createStore({ file, now: () => clock.t, log: (m) => logs.push(m), ...extra });
  const base = { creator: 'owner', ownerId: 'mine', agent: null, root: dir, rel: 'a.txt', name: 'a.txt', size: 3, dev: 1, ino: 2, mtimeMs: 3, hours: 24, oneTime: false };
  return { dir, clock, file, logs, make, store: make(), base };
}

test('token: 43 base64url characters, 256 bits, different every time', (t) => {
  const { store, base } = rig(t);
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const { token } = store.create({ ...base, creator: `u${i % 2}` });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    seen.add(token);
  }
  assert.equal(seen.size, 20);
});

test('only the hash is stored: the file never holds the token, is 0600 and is replaced atomically', (t) => {
  const { store, base, file, dir } = rig(t);
  const { token, record } = store.create(base);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(token));
  assert.ok(text.includes(SL.sha256(token)));
  assert.equal(record.hash, undefined, 'the store never hands the hash out');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['share-links.json'], 'no temp file left behind');
  assert.match(record.id, /^[0-9a-f]{16}$/);
  // a write that fails halfway leaves the old file untouched
  const renames = [];
  const bad = { ...fs, renameSync: (a, b) => { renames.push(a); throw new Error('disk full'); } };
  const s2 = SL.createStore({ file, fsImpl: bad, now: () => 1_800_000_000_000, log: () => {} });
  assert.throws(() => s2.create(base), /disk full/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['share-links.json']);
  assert.ok(dir);
});

test('a token is never logged', (t) => {
  const { store, base, logs } = rig(t);
  const { token } = store.create(base);
  store.findLive(token); store.markDownload(store.list()[0].id); store.revoke(store.list()[0].id);
  assert.ok(!logs.join('\n').includes(token));
});

test('a damaged file starts empty, is logged, and the store keeps working', (t) => {
  const { dir, file, make, base, logs } = rig(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const s = make();
  assert.deepEqual(s.list(), []);
  assert.ok(logs.some(l => /damaged/.test(l)));
  const { token } = s.create(base);
  assert.ok(s.findLive(token));
  assert.ok(dir);
});

test('the store survives a reload', (t) => {
  const { store, base, make } = rig(t);
  const { token } = store.create(base);
  assert.ok(make().findLive(token));
});

test('findLive: pattern check, unknown token, expiry, revoke', (t) => {
  const { store, base, clock } = rig(t);
  const { token, record } = store.create({ ...base, hours: 1 });
  assert.equal(store.findLive(token).id, record.id);
  assert.equal(store.findLive(token.slice(1)), null);
  assert.equal(store.findLive(token + 'A'), null);
  assert.equal(store.findLive('A'.repeat(43)), null);
  assert.equal(store.findLive(null), null);
  assert.equal(store.findLive({ toString: () => token }), null);
  clock.t += 3600 * 1000 - 1;
  assert.ok(store.findLive(token));
  clock.t += 1;
  assert.equal(store.findLive(token), null, 'expired');
  const b = store.create(base);
  assert.equal(store.revoke(b.record.id), true);
  assert.equal(store.findLive(b.token), null, 'revoked');
  assert.equal(store.revoke(b.record.id), false, 'revoking twice');
  assert.equal(store.revoke('0000000000000000'), false);
});

test('hours: an integer from 1 to the maximum, else EBADARG', (t) => {
  const { store, base } = rig(t);
  for (const h of [0, -1, 1.5, '24', NaN, null, undefined, 169, 1000]) {
    assert.throws(() => store.create({ ...base, hours: h }), (e) => e.code === 'EBADARG', String(h));
  }
  assert.throws(() => store.create({ ...base, hours: 49, maxHours: 48 }), (e) => e.code === 'EBADARG');
  assert.throws(() => store.create({ ...base, hours: 200, maxHours: 500 }), (e) => e.code === 'EBADARG', 'maxHours never above 168');
  const r = store.create({ ...base, hours: 168 }).record;
  assert.equal(r.expiresAt - r.createdAt, 168 * 3600 * 1000);
});

test('limits: 50 live per creator, 500 per hub (ELIMIT); ended links do not count', (t) => {
  const { store, base, clock } = rig(t);
  const first = [];
  for (let i = 0; i < 50; i++) first.push(store.create({ ...base, hours: 1 }));
  assert.throws(() => store.create(base), (e) => e.code === 'ELIMIT');
  assert.doesNotThrow(() => store.create({ ...base, creator: 'sam' }), 'another person is not limited by owner');
  store.revoke(first[0].record.id);
  assert.doesNotThrow(() => store.create(base));
  clock.t += 2 * 3600 * 1000;   // the 1-hour links expire
  assert.doesNotThrow(() => store.create(base));
  // hub-wide
  const { store: s2, base: b2 } = rig(t);
  for (let i = 0; i < 500; i++) s2.create({ ...b2, creator: `member-${i % 20}`, hours: 1 });
  assert.equal(s2.liveList().length, 500);
  assert.throws(() => s2.create({ ...b2, creator: 'member-new' }), (e) => e.code === 'ELIMIT');
});

test('one-time: used up exactly once, before streaming; a normal link counts downloads', (t) => {
  const { store, base } = rig(t);
  const one = store.create({ ...base, oneTime: true });
  assert.equal(store.markDownload(one.record.id), true);
  assert.equal(store.markDownload(one.record.id), false);
  assert.equal(store.findLive(one.token), null, 'a used-up link is dead');
  const many = store.create(base);
  assert.equal(store.markDownload(many.record.id), true);
  assert.equal(store.markDownload(many.record.id), true);
  assert.equal(store.get(many.record.id).downloads, 2);
  assert.equal(store.markDownload('ffffffffffffffff'), false);
  // two "parallel" callers: exactly one passes
  const p = store.create({ ...base, oneTime: true });
  const results = [store.markDownload(p.record.id), store.markDownload(p.record.id)];
  assert.deepEqual(results.sort(), [false, true]);
});

test('prune: drops links that ended more than 24 hours ago, keeps the rest; runs on load', (t) => {
  const { store, base, clock, make } = rig(t);
  const old = store.create({ ...base, hours: 1 });
  const revoked = store.create(base); store.revoke(revoked.record.id);
  const used = store.create({ ...base, oneTime: true }); store.markDownload(used.record.id);
  const live = store.create(base);
  clock.t += 23 * 3600 * 1000;
  assert.equal(store.prune(), 0, 'ended less than 24 hours ago (or never)');
  clock.t += 3 * 3600 * 1000;   // 26 h after creation: the 1 h link ended 25 h ago, the revoked and used ones 26 h; the 24 h link 2 h ago
  assert.equal(store.list().length, 4);
  assert.equal(store.prune(), 3);
  assert.deepEqual(store.list().map(r => r.id), [live.record.id], 'a link that ended 2 hours ago is kept');
  assert.ok(old);
  clock.t += 7 * 24 * 3600 * 1000;
  const again = make();   // loading prunes
  assert.deepEqual(again.list(), []);
});

test('the daily prune timer does not keep the process alive', (t) => {
  const { store } = rig(t);
  let unrefd = false, ms = 0;
  store.startPruneTimer((fn, interval) => { ms = interval; return { unref() { unrefd = true; } }; });
  assert.equal(ms, 24 * 3600 * 1000);
  assert.ok(unrefd);
});

test('cleanSettings: defaults, integers >= 1, hard maximum 168, default never above the maximum', () => {
  assert.deepEqual(SL.cleanSettings(undefined, undefined), { enabled: true, defaultHours: 24, maxHours: 168 });
  assert.deepEqual(SL.cleanSettings({}, {}), { enabled: true, defaultHours: 24, maxHours: 168 });
  assert.equal(SL.cleanSettings({ maxHours: 1000 }).maxHours, 168);
  assert.equal(SL.cleanSettings({ maxHours: 168.5 }).maxHours, 168);
  assert.equal(SL.cleanSettings({ maxHours: 0 }).maxHours, 168);
  assert.equal(SL.cleanSettings({ maxHours: -5 }).maxHours, 168);
  assert.equal(SL.cleanSettings({ maxHours: 'x' }).maxHours, 168);
  assert.equal(SL.cleanSettings({ maxHours: 48 }).maxHours, 48);
  assert.equal(SL.cleanSettings({ maxHours: 48 }).defaultHours, 24);
  assert.equal(SL.cleanSettings({ maxHours: 6 }).defaultHours, 6);
  assert.equal(SL.cleanSettings({ defaultHours: 500 }).defaultHours, 168);
  assert.equal(SL.cleanSettings({ defaultHours: 0 }).defaultHours, 24);
  assert.equal(SL.cleanSettings({ enabled: false }).enabled, false);
  assert.equal(SL.cleanSettings({ enabled: 'no' }).enabled, true);
  // merged onto the stored value
  assert.deepEqual(SL.cleanSettings({ enabled: false }, { enabled: true, defaultHours: 2, maxHours: 12 }), { enabled: false, defaultHours: 2, maxHours: 12 });
  assert.deepEqual(SL.cleanSettings({ maxHours: 1 }, { defaultHours: 2, maxHours: 12 }), { enabled: true, defaultHours: 1, maxHours: 1 });
  assert.deepEqual(SL.cleanSettings('junk', null), { enabled: true, defaultHours: 24, maxHours: 168 });
  assert.deepEqual(SL.cleanSettings([1], [2]), { enabled: true, defaultHours: 24, maxHours: 168 });
});

// ── openChecked: real files ──
function fileRig(t) {
  const dir = fs.realpathSync(tmp(t));
  const root = path.join(dir, 'root');
  fs.mkdirSync(root);
  const abs = path.join(root, 'doc.txt');
  fs.writeFileSync(abs, 'hello world');
  const st = fs.statSync(abs);
  const record = { root, rel: 'doc.txt', size: st.size, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  return { dir, root, abs, record };
}

test('openChecked: the same file opens and reads from the descriptor', (t) => {
  const { record } = fileRig(t);
  const r = SL.openChecked(record);
  assert.ok(r);
  assert.equal(fs.readFileSync(r.fd, 'utf8'), 'hello world');
  fs.closeSync(r.fd);
});

test('openChecked refuses a symlink in place of the file', (t) => {
  const { dir, abs, record } = fileRig(t);
  const other = path.join(dir, 'other.txt'); fs.writeFileSync(other, 'hello world');
  fs.rmSync(abs); fs.symlinkSync(other, abs);
  assert.equal(SL.openChecked(record), null);
});

test('openChecked refuses a replaced file (new inode), an edited file (size, mtime) and a deleted file', (t) => {
  const { abs, record, root } = fileRig(t);
  const copy = path.join(root, 'new.txt'); fs.writeFileSync(copy, 'hello world');
  fs.renameSync(copy, abs);   // same name and size, a different inode
  assert.equal(SL.openChecked(record), null, 'new inode');
  const f2 = fileRig(t);
  fs.appendFileSync(f2.abs, '!');
  assert.equal(SL.openChecked(f2.record), null, 'size changed');
  const f3 = fileRig(t);
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(f3.abs, later, later);
  assert.equal(SL.openChecked(f3.record), null, 'mtime changed');
  const f4 = fileRig(t);
  fs.rmSync(f4.abs);
  assert.equal(SL.openChecked(f4.record), null, 'gone');
  assert.equal(SL.openChecked(null), null);
});

test('openChecked refuses a path that leaves the root through a symlinked folder, and a folder in place of the file', (t) => {
  const { dir, root } = fileRig(t);
  const outside = path.join(dir, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'hello world');
  fs.symlinkSync(outside, path.join(root, 'link'));
  const st = fs.statSync(path.join(outside, 'secret.txt'));
  const record = { root, rel: 'link/secret.txt', size: st.size, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  assert.equal(SL.openChecked(record), null);
  const dst = fs.statSync(root);
  assert.equal(SL.openChecked({ root: dir, rel: 'root', size: dst.size, dev: dst.dev, ino: dst.ino, mtimeMs: dst.mtimeMs }), null, 'a folder');
});

test('openChecked closes the descriptor when it refuses', (t) => {
  const { record, root } = fileRig(t);
  const opened = [], closed = [];
  const spy = { ...fs, constants: fs.constants, openSync: (...a) => { const fd = fs.openSync(...a); opened.push(fd); return fd; }, closeSync: (fd) => { closed.push(fd); fs.closeSync(fd); } };
  assert.equal(SL.openChecked({ ...record, size: 999 }, spy), null);
  assert.deepEqual(opened, closed);
  assert.equal(opened.length, 1);
  assert.ok(root);
});

test('contentDisposition: quotes, backslash, semicolon, CR/LF and non-ASCII', () => {
  const cd = SL.contentDisposition('re"po;rt\\ \r\nné日本.pdf');
  assert.ok(!/[\r\n]/.test(cd));
  const m = cd.match(/^attachment; filename="([^"]*)"; filename\*=UTF-8''(.*)$/);
  assert.ok(m, cd);
  assert.ok(!/["\\;\r\n]/.test(m[1]), 'fallback: ' + m[1]);
  assert.match(m[1], /^[\x20-\x7e]*$/);
  assert.equal(m[1], 'report n___.pdf'.replace('n___', 'n___'), 'non-ASCII letters become _');
  assert.equal(decodeURIComponent(m[2]), 're"po;rt\\ \r\nné日本.pdf');
  assert.ok(!/[ "';\\()*!]/.test(m[2]), 'the extended value is fully percent-encoded: ' + m[2]);
  assert.equal(SL.contentDisposition('plain.txt'), `attachment; filename="plain.txt"; filename*=UTF-8''plain.txt`);
  assert.match(SL.contentDisposition('\r\n'), /filename="download"/);
  assert.match(SL.contentDisposition("it's (1).txt"), /filename\*=UTF-8''it%27s%20%281%29\.txt$/);
});

test('renderPage: escapes every value, no script, a POST form with one Download button', () => {
  const html = SL.renderPage({ name: '<script>alert(1)</script>"&\'.txt', size: 1_500_000, expiresAt: Date.UTC(2026, 10, 18, 5, 30), oneTime: true });
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;.txt'));
  assert.ok(html.includes('1.5 MB'));
  assert.ok(html.includes('Link expires <time datetime="2026-11-18T05:30:00.000Z">2026-11-18 05:30 UTC</time>'));
  assert.ok(html.includes('One download'));
  assert.equal((html.match(/<form method="post">/g) || []).length, 1);
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.ok(!/\son[a-z]+=/i.test(html.replace(/<style>[\s\S]*<\/style>/, '')), 'no event handlers');
  assert.ok(!SL.renderPage({ name: 'a', size: 5, expiresAt: Date.now(), oneTime: false }).includes('One download'));
  // The person's own time zone when known, UTC otherwise (and for an unknown zone); the page never sends anything to another site.
  const t = Date.UTC(2026, 10, 18, 5, 30);
  assert.match(SL.renderPage({ name: 'a', size: 5, expiresAt: t, timeZone: 'America/New_York' }), /Nov 18, 2026, 12:30\s?AM EST/);
  assert.match(SL.renderPage({ name: 'a', size: 5, expiresAt: t }), /2026-11-18 05:30 UTC/);
  assert.match(SL.renderPage({ name: 'a', size: 5, expiresAt: t, timeZone: 'Not/AZone' }), /2026-11-18 05:30 UTC/);
  assert.match(SL.renderPage({ name: 'a', size: 5, expiresAt: t }), /<meta name="referrer" content="same-origin">/);
  assert.ok(SL.renderPage({ name: 'a', size: 5, expiresAt: Date.now() }).includes('5 bytes'));
  assert.ok(SL.renderPage({ name: 'a', size: 2500, expiresAt: Date.now() }).includes('2.5 KB'));
});

test('renderGone: only "This link no longer works."', () => {
  const html = SL.renderGone();
  assert.ok(html.includes('This link no longer works.'));
  assert.ok(!/<script|<form|<button/i.test(html));
  assert.equal(html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), 'Link This link no longer works.');
});

test('limiter: a sliding window per key, and blocks that run out', () => {
  let t = 0;
  const lim = SL.createLimiter({ now: () => t });
  const o = { limit: 3, windowMs: 1000 };
  assert.deepEqual([1, 2, 3, 4].map(() => lim.hit('k', o)), [true, true, true, false]);
  assert.equal(lim.hit('other', o), true, 'keys are separate');
  t = 1000;
  assert.equal(lim.hit('k', o), true, 'the window moved on');
  lim.block('b', 500);
  assert.equal(lim.isBlocked('b'), true);
  t = 1600;
  assert.equal(lim.isBlocked('b'), false);
});
