'use strict';
// Ring module: lib/store.js, state files and the pinned-descriptor media writer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, writePrivate, writeJsonPrivate, createBuckets, normCode, INBOX_MAX, BUCKET_MAX, LINK_MAX_TRIES } = require('../modules/ring/lib/store');

const H = 3600 * 1000;
function env(t, over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-store-'));
  const dataHome = path.join(tmp, 'data'), mediaDir = path.join(tmp, 'media');
  fs.mkdirSync(mediaDir, { mode: 0o775 });
  const clock = { t: 1_800_000_000_000 };
  const logs = [];
  const store = createStore({ dataHome, mediaDir, now: () => clock.t, log: (...a) => logs.push(a.join(' ')), ...over });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return { tmp, dataHome, mediaDir, clock, logs, store };
}
const mode = (p) => fs.lstatSync(p).mode & 0o777;
const names = (dir) => fs.readdirSync(dir).sort();

// ── atomic private files ────────────────────────────────────────────────────────────────────────────────────

test('writePrivate: file 0600, folders 0700, replaced whole, no temp file left', (t) => {
  const e = env(t);
  const f = path.join(e.tmp, 'sub', 'deeper', 'x.json');
  writeJsonPrivate(f, { a: 1 });
  assert.equal(mode(f), 0o600);
  assert.equal(mode(path.dirname(f)), 0o700);
  writePrivate(f, 'second\n');
  assert.equal(fs.readFileSync(f, 'utf8'), 'second\n');
  assert.deepEqual(names(path.dirname(f)), ['x.json']);
  fs.chmodSync(f, 0o666);
  writePrivate(f, 'third');
  assert.equal(mode(f), 0o600, 'the mode is reset on every write');
});

test('writePrivate: a failed write leaves the old file and no temp file', (t) => {
  const e = env(t);
  const f = path.join(e.tmp, 'keep.txt');
  writePrivate(f, 'old');
  const dirTarget = path.join(e.tmp, 'isdir');
  fs.mkdirSync(dirTarget);
  assert.throws(() => writePrivate(dirTarget, 'x'));   // renaming a file over a folder fails
  assert.equal(fs.readFileSync(f, 'utf8'), 'old');
  assert.deepEqual(names(e.tmp).filter((n) => n.endsWith('.tmp')), []);
});

test('store files: readText/writeText/readJson/writeJson inside dataHome (0600); missing gives the default', (t) => {
  const e = env(t);
  assert.equal(e.store.readText('nope'), null);
  assert.deepEqual(e.store.readJson('nope', { d: 1 }), { d: 1 });
  e.store.writeText('t.txt', 'hi');
  e.store.writeJson('j.json', { a: [1] });
  assert.equal(e.store.readText('t.txt'), 'hi');
  assert.deepEqual(e.store.readJson('j.json', null), { a: [1] });
  assert.equal(mode(path.join(e.dataHome, 't.txt')), 0o600);
  assert.equal(mode(e.dataHome), 0o700);
  fs.writeFileSync(path.join(e.dataHome, 'bad.json'), '{not json');
  assert.deepEqual(e.store.readJson('bad.json', { ok: 1 }), { ok: 1 });
});

// ── state, inbox, coalescing, outbox, recent ────────────────────────────────────────────────────────────────

test('state: saved 0600, survives a restart; unknown shapes are repaired', (t) => {
  const e = env(t);
  e.store.state().lastNotice.k = 5;
  e.store.saveState();
  assert.equal(mode(path.join(e.dataHome, 'state.json')), 0o600);
  const again = createStore({ dataHome: e.dataHome, mediaDir: e.mediaDir, now: () => e.clock.t });
  assert.equal(again.state().lastNotice.k, 5);
  fs.writeFileSync(path.join(e.dataHome, 'state.json'), JSON.stringify({ inbox: 'x', seen: [] }));
  const bad = createStore({ dataHome: e.dataHome, mediaDir: e.mediaDir });
  assert.deepEqual(bad.state().inbox, []);
  assert.deepEqual(bad.state().seen, {});
});

test('acceptEvent: duplicates ignored; inbox capped at 500 (then "full"); every accepted event is on disk', (t) => {
  const e = env(t);
  assert.equal(e.store.acceptEvent('r1', { id: 'r1', at: e.clock.t }), 'ok');
  assert.equal(e.store.acceptEvent('r1', { id: 'r1', at: e.clock.t }), 'duplicate');
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.dataHome, 'state.json'), 'utf8')).inbox.length, 1);
  for (let i = 2; i <= INBOX_MAX; i++) assert.equal(e.store.acceptEvent(`r${i}`, { id: `r${i}`, at: e.clock.t }), 'ok');
  assert.equal(e.store.acceptEvent('over', { id: 'over', at: e.clock.t }), 'full');
  assert.equal(e.store.state().inbox.length, INBOX_MAX);
  assert.equal(e.store.state().seen.over, undefined, 'a refused event is not remembered');
  assert.equal(INBOX_MAX, 500);
});

test('acceptEvent: a failed save rolls the event back and throws', (t) => {
  const e = env(t);
  e.store.state();   // loaded while the file is absent
  fs.mkdirSync(path.join(e.dataHome, 'state.json'), { recursive: true });   // a folder where the file belongs: the save fails
  assert.throws(() => e.store.acceptEvent('r1', { id: 'r1', at: e.clock.t }));
  assert.equal(e.store.state().inbox.length, 0);
  assert.equal(e.store.state().seen.r1, undefined);
});

test('inbox: entries older than 6 h are dropped; removal is saved', (t) => {
  const e = env(t);
  e.store.acceptEvent('old', { id: 'old', at: e.clock.t });
  e.clock.t += 5 * H;
  e.store.acceptEvent('new', { id: 'new', at: e.clock.t });
  assert.equal(e.store.inboxList().length, 2);
  e.clock.t += 1.5 * H;
  assert.deepEqual(e.store.inboxList().map((x) => x.id), ['new']);
  assert.match(e.logs.join('\n'), /dropped 1 event/);
  e.store.inboxRemove('new');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.dataHome, 'state.json'), 'utf8')).inbox, []);
});

test('seen ids: dropped after 72 h; young ids are never evicted, the 50,001st is refused', (t) => {
  const e = env(t);
  e.store.acceptEvent('a', { id: 'a', at: e.clock.t });
  e.clock.t += 73 * H;
  e.store.acceptEvent('b', { id: 'b', at: e.clock.t });
  assert.deepEqual(Object.keys(e.store.state().seen), ['b']);
  const st = e.store.state();
  for (let i = 0; i < 49999; i++) st.seen[`x${i}`] = e.clock.t - 49 * H + i;   // 49 h old: older than 48 h 10 min, younger than 72 h
  e.store.saveState();
  assert.equal(Object.keys(e.store.state().seen).length, 50000, 'saving never evicts a young id');
  assert.equal(e.store.acceptEvent('c', { id: 'c', at: e.clock.t }), 'full');
  assert.ok(!('c' in e.store.state().seen) && 'x0' in e.store.state().seen);
  assert.equal(e.store.acceptEvent('b', { id: 'b', at: e.clock.t }), 'duplicate');
});

test('unreadableFiles names the state files that exist but cannot be read', (t) => {
  const e = env(t);
  assert.deepEqual(e.store.unreadableFiles(), []);
  fs.mkdirSync(e.dataHome, { recursive: true });
  fs.writeFileSync(path.join(e.dataHome, 'state.json'), '{garbled');
  assert.deepEqual(e.store.unreadableFiles(), ['state.json']);
});

test('coalescing: last notice time and suppressed count are kept and cleared', (t) => {
  const e = env(t);
  assert.deepEqual(e.store.coalescing.get('k'), { last: 0, suppressed: 0 });
  e.store.coalescing.set('k', { last: e.clock.t, suppressed: 2 });
  assert.deepEqual(createStore({ dataHome: e.dataHome }).coalescing.get('k'), { last: e.clock.t, suppressed: 2 });
  e.store.coalescing.set('k', { last: e.clock.t + 1, suppressed: 0 });
  assert.deepEqual(e.store.coalescing.get('k'), { last: e.clock.t + 1, suppressed: 0 });
  e.store.coalescing.clear('k');
  assert.deepEqual(e.store.coalescing.get('k'), { last: 0, suppressed: 0 });
});

test('outbox: kept, removed, dropped after 6 h', (t) => {
  const e = env(t);
  e.store.outbox.push({ text: 'one', files: [] });
  e.clock.t += 5 * H;
  e.store.outbox.push({ text: 'two', files: ['stills/a/b.jpg'] });
  assert.equal(e.store.outbox.prune(), 0);
  e.clock.t += 1.2 * H;
  assert.equal(e.store.outbox.prune(), 1);
  const [item] = e.store.outbox.list();
  assert.equal(item.text, 'two');
  e.store.outbox.remove(e.store.state().outbox[0]);
  assert.deepEqual(e.store.outbox.list(), []);
});

test('recent: files named in notices are protected for 7 h', (t) => {
  const e = env(t);
  e.store.recent.add(['stills/2026-01-01/0900-front.jpg', '']);
  assert.deepEqual([...e.store.recent.keep()], ['stills/2026-01-01/0900-front.jpg']);
  e.clock.t += 6.9 * H;
  assert.equal(e.store.recent.keep().size, 1);
  e.clock.t += 0.2 * H;
  assert.equal(e.store.recent.keep().size, 0);
});

test('key encoding: utf8 by default, remembered through state.json', (t) => {
  const e = env(t);
  assert.equal(e.store.keyEncoding(), 'utf8');
  e.store.setKeyEncoding('bogus');
  assert.equal(e.store.keyEncoding(), 'utf8');
  e.store.setKeyEncoding('base64');
  assert.equal(createStore({ dataHome: e.dataHome }).keyEncoding(), 'base64');
});

// ── account, pending tokens, devices, unsaved ───────────────────────────────────────────────────────────────

test('account: linked/claimed/relink flag; file is 0600', (t) => {
  const e = env(t);
  assert.equal(e.store.account(), null);
  assert.equal(e.store.claimedAccount(), null);
  e.store.saveAccount({ account_id: 'acct-1', claimed_at: 1, needs_relink: false, access: { access_token: 'a' } });
  assert.equal(e.store.claimedAccount(), 'acct-1');
  e.store.setNeedsRelink('Ring rejected the stored sign-in (invalid_grant)\nsecond line');
  assert.equal(e.store.claimedAccount(), null);
  assert.equal(e.store.linkedAccount(), 'acct-1');
  assert.ok(!/\n/.test(e.store.account().relink_reason));
  e.store.clearRelink();
  assert.equal(e.store.claimedAccount(), 'acct-1');
  assert.equal(e.store.account().relink_reason, undefined);
  assert.equal(mode(path.join(e.dataHome, 'account.json')), 0o600);
  e.store.setNeedsRelink('x');
  const kept = createStore({ dataHome: e.dataHome });
  assert.equal(kept.account().needs_relink, true);
});

test('pending link tokens: kept per account id, taken once, expire after 1 h; the account record keeps them apart', (t) => {
  const e = env(t);
  e.store.savePending('acct-9', { access_token: 'a', refresh_token: 'r', expires_at: 1, obtained_at: e.clock.t }, 'o***r@example.com');
  assert.equal(e.store.pending()['acct-9'].email_masked, 'o***r@example.com');
  assert.equal(e.store.account(), null);
  e.clock.t += 0.9 * H;
  assert.equal(e.store.dropExpiredPending(), false);
  e.clock.t += 0.2 * H;
  assert.equal(e.store.dropExpiredPending(), true);
  assert.deepEqual(e.store.pending(), {});
  e.store.savePending('acct-2', { access_token: 'a', refresh_token: 'r' });
  assert.equal(e.store.takePending('acct-2').refresh_token, 'r');
  assert.equal(e.store.takePending('acct-2'), null);
});

test('devices cache and unsaved token files (0600); unsaved.clear is quiet when absent', (t) => {
  const e = env(t);
  assert.deepEqual(e.store.devices.get(), {});
  e.store.devices.save({ fetchedAt: 'x', devices: { d: { name: 'n' } } });
  assert.equal(e.store.devices.get().devices.d.name, 'n');
  assert.equal(e.store.unsaved.get(), null);
  e.store.unsaved.clear();
  e.store.unsaved.set('r-new');
  assert.equal(e.store.unsaved.get(), 'r-new');
  assert.equal(mode(path.join(e.dataHome, 'unsaved.json')), 0o600);
  e.store.unsaved.clear();
  assert.equal(e.store.unsaved.get(), null);
});

// ── the link code ───────────────────────────────────────────────────────────────────────────────────────────

test('linkArm: code format, only a salted hash on disk (0600), minutes clamped, expiry', (t) => {
  const e = env(t);
  assert.equal(e.store.linkArm.get(), null);
  const r = e.store.linkArm.arm({ minutes: 1000, replace: true });
  assert.match(r.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  assert.equal(r.minutes, 120);
  assert.equal(r.replace, true);
  const raw = fs.readFileSync(path.join(e.dataHome, 'link-arm.json'), 'utf8');
  assert.ok(!raw.includes(r.code) && !raw.includes(r.code.replace('-', '')));
  assert.equal(mode(path.join(e.dataHome, 'link-arm.json')), 0o600);
  assert.equal(e.store.linkArm.arm({ minutes: 0 }).minutes, 30);
  assert.equal(e.store.linkArm.arm({ minutes: 2 }).minutes, 5);
  const r2 = e.store.linkArm.arm({ minutes: 5 });
  assert.ok(e.store.linkArm.matches(r2.code));
  assert.ok(e.store.linkArm.matches(r2.code.toLowerCase().replace('-', ' ')), 'case and separators do not matter');
  assert.ok(!e.store.linkArm.matches('AAAA-AAAA'));
  assert.equal(normCode('ab-12 x'), 'AB12X');
  e.clock.t += 6 * 60000;
  assert.equal(e.store.linkArm.get(), null);
  assert.ok(!e.store.linkArm.matches(r2.code), 'an expired code never matches');
});

test('linkArm: five wrong codes delete the record; a new arm starts fresh', (t) => {
  const e = env(t);
  e.store.linkArm.arm({ minutes: 30 });
  for (let i = 1; i < LINK_MAX_TRIES; i++) assert.deepEqual(e.store.linkArm.wrong(), { tries: i, closed: false });
  assert.deepEqual(e.store.linkArm.wrong(), { tries: 5, closed: true });
  assert.equal(e.store.linkArm.get(), null);
  assert.ok(!fs.existsSync(path.join(e.dataHome, 'link-arm.json')));
  assert.deepEqual(e.store.linkArm.wrong(), { tries: 0, closed: true });
  e.store.linkArm.arm({ minutes: 30 });
  assert.equal(e.store.linkArm.get().tries, 0);
});

test('linkArm.clear(id) removes only the code that was used', (t) => {
  const e = env(t);
  const a = e.store.linkArm.arm({ minutes: 30 });
  const b = e.store.linkArm.arm({ minutes: 30 });   // armed again meanwhile
  e.store.linkArm.clear(a.id);
  assert.ok(e.store.linkArm.get(), 'the newer code stays');
  e.store.linkArm.clear(b.id);
  assert.equal(e.store.linkArm.get(), null);
});

// ── the media folder, through pinned descriptors ────────────────────────────────────────────────────────────

test('mediaPut: writes under a hidden temp name then takes the real name; mode 0664; folders 0775; no temp left', (t) => {
  const e = env(t);
  const r = e.store.mediaPut({ parts: ['stills', '2026-01-01'], names: ['0900-front.jpg'], buf: Buffer.from('JPEGDATA') });
  assert.deepEqual(r, { name: '0900-front.jpg', parts: ['stills', '2026-01-01'] });
  const dir = path.join(e.mediaDir, 'stills', '2026-01-01');
  assert.deepEqual(names(dir), ['0900-front.jpg']);
  assert.equal(fs.readFileSync(path.join(dir, '0900-front.jpg'), 'utf8'), 'JPEGDATA');
  assert.equal(mode(path.join(dir, '0900-front.jpg')), 0o664);
  assert.equal(fs.statSync(path.join(dir, '0900-front.jpg')).nlink, 1);
  assert.equal(mode(dir), 0o775 & ~process.umask());
});

test('mediaPut: exclusive create takes the next free name; all names taken is an error; nothing is overwritten', (t) => {
  const e = env(t);
  const dir = path.join(e.mediaDir, 'stills', 'd');
  const put = (buf) => e.store.mediaPut({ parts: ['stills', 'd'], names: ['a.jpg', 'a-2.jpg', 'a-3.jpg'], buf: Buffer.from(buf) });
  assert.equal(put('one').name, 'a.jpg');
  assert.equal(put('two').name, 'a-2.jpg');
  assert.equal(put('three').name, 'a-3.jpg');
  assert.throws(() => put('four'), /too many files with the same name/);
  assert.deepEqual(names(dir), ['a-2.jpg', 'a-3.jpg', 'a.jpg']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.jpg'), 'utf8'), 'one');
});

test('mediaPut: a link planted under the next name is skipped, never written through', (t) => {
  const e = env(t);
  const dir = path.join(e.mediaDir, 'stills', 'd');
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(e.tmp, 'victim.txt');
  fs.writeFileSync(victim, 'precious');
  fs.symlinkSync(victim, path.join(dir, 'a.jpg'));
  const r = e.store.mediaPut({ parts: ['stills', 'd'], names: ['a.jpg', 'a-2.jpg'], buf: Buffer.from('NEW') });
  assert.equal(r.name, 'a-2.jpg');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious');
  assert.ok(fs.lstatSync(path.join(dir, 'a.jpg')).isSymbolicLink());
  assert.deepEqual(names(dir), ['a-2.jpg', 'a.jpg']);
});

test('mediaPut: a day folder swapped for a link is refused; nothing is written through it', (t) => {
  const e = env(t);
  const decoy = path.join(e.tmp, 'decoy');
  fs.mkdirSync(decoy);
  fs.mkdirSync(path.join(e.mediaDir, 'clips'));
  fs.symlinkSync(decoy, path.join(e.mediaDir, 'clips', '2026-01-01'));
  assert.throws(() => e.store.mediaPut({ parts: ['clips', '2026-01-01'], names: ['x.mp4'], buf: Buffer.from('X') }), (err) => err.code === 'not a plain folder');
  assert.deepEqual(fs.readdirSync(decoy), []);
  // and a link planted in the middle of the path
  fs.rmSync(path.join(e.mediaDir, 'clips'), { recursive: true });
  fs.symlinkSync(decoy, path.join(e.mediaDir, 'clips'));
  assert.throws(() => e.store.mediaPut({ parts: ['clips', 'd'], names: ['x.mp4'], buf: Buffer.from('X') }), (err) => err.code === 'not a plain folder');
  assert.deepEqual(fs.readdirSync(decoy), []);
});

test('mediaPut: a file where a folder should be is refused', (t) => {
  const e = env(t);
  fs.writeFileSync(path.join(e.mediaDir, 'stills'), 'file');
  assert.throws(() => e.store.mediaPut({ parts: ['stills', 'd'], names: ['x.jpg'], buf: Buffer.from('X') }), (err) => err.code === 'not a plain folder');
});

test('mediaPut: the media root replaced by a link between runs is refused', (t) => {
  const e = env(t);
  e.store.mediaPut({ parts: ['stills', 'd'], names: ['x.jpg'], buf: Buffer.from('X') });
  const other = path.join(e.tmp, 'other');
  fs.mkdirSync(other);
  fs.renameSync(e.mediaDir, path.join(e.tmp, 'media-moved'));
  fs.symlinkSync(other, e.mediaDir);
  assert.throws(() => e.store.mediaPut({ parts: ['stills', 'd'], names: ['y.jpg'], buf: Buffer.from('Y') }), (err) => err.code === 'not a plain folder');
  assert.deepEqual(fs.readdirSync(other), []);
  assert.deepEqual(e.store.mediaList(['stills', 'd']), []);
});

test('mediaPut: folder parts that climb out or hold separators are refused', (t) => {
  const e = env(t);
  for (const parts of [['..'], ['stills', '..', '..'], ['a/b'], ['.'], [''], 'stills', ['x\0y']]) {
    assert.throws(() => e.store.mediaPut({ parts, names: ['x.jpg'], buf: Buffer.from('X') }), (err) => err.code === 'bad folder', JSON.stringify(parts));
  }
  assert.deepEqual(fs.readdirSync(e.tmp).filter((n) => n !== 'data' && n !== 'media'), []);
});

test('mediaPut: refuses when the disk is nearly full (reserve plus the file)', (t) => {
  const e = env(t, { freeBytes: () => 2 * 1024 * 1024 * 1024 + 5 });
  assert.throws(() => e.store.mediaPut({ parts: ['s'], names: ['x.jpg'], buf: Buffer.alloc(10) }), (err) => err.code === 'disk nearly full');
  assert.ok(!fs.existsSync(path.join(e.mediaDir, 's')));
  assert.equal(e.store.mediaPut({ parts: ['s'], names: ['x.jpg'], buf: Buffer.alloc(3) }).name, 'x.jpg');
  assert.equal(e.store.mediaPut({ parts: ['s'], names: ['y.jpg'], buf: Buffer.alloc(3000), reserve: 0 }).name, 'y.jpg');
});

test('mediaPut: a finished file from the work area is copied in (not linked) and the source removed on request', (t) => {
  const e = env(t);
  const src = e.store.workFile('mp4');
  fs.writeFileSync(src, Buffer.alloc(3 * 1024 * 1024 + 17, 9), { mode: 0o600 });
  const srcIno = fs.statSync(src).ino;
  const r = e.store.mediaPut({ parts: ['clips', 'd'], names: ['c.mp4'], file: src, removeSource: true });
  const out = path.join(e.mediaDir, 'clips', 'd', r.name);
  assert.equal(fs.statSync(out).size, 3 * 1024 * 1024 + 17);
  assert.notEqual(fs.statSync(out).ino, srcIno);
  assert.equal(fs.statSync(out).nlink, 1);
  assert.ok(!fs.existsSync(src));
  assert.equal(mode(out), 0o664);
  assert.equal(mode(e.store.workDir), 0o700);
  const src2 = e.store.workFile('mp4');
  fs.writeFileSync(src2, 'x');
  e.store.mediaPut({ parts: ['clips', 'd'], names: ['d.mp4'], file: src2 });
  assert.ok(fs.existsSync(src2), 'kept unless removal is asked for');
});

test('mediaPut: works when the data home and the media folder are on different filesystems (no hard link across them)', (t) => {
  const shm = '/dev/shm';
  if (!fs.existsSync(shm)) return t.skip('no /dev/shm');
  const dataHome = fs.mkdtempSync(path.join(shm, 'ring-store-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-store-'));
  t.after(() => { fs.rmSync(dataHome, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); });
  if (fs.statSync(dataHome).dev === fs.statSync(tmp).dev) return t.skip('both folders are on one filesystem here');
  const mediaDir = path.join(tmp, 'media');
  fs.mkdirSync(mediaDir);
  const store = createStore({ dataHome, mediaDir });
  const src = store.workFile('mp4');
  fs.writeFileSync(src, 'clipdata');
  assert.throws(() => fs.linkSync(src, path.join(mediaDir, 'probe')), (err) => err.code === 'EXDEV');
  const r = store.mediaPut({ parts: ['clips', 'd'], names: ['c.mp4'], file: src, removeSource: true });
  assert.equal(fs.readFileSync(path.join(mediaDir, 'clips', 'd', r.name), 'utf8'), 'clipdata');
  assert.ok(!fs.existsSync(src));
});

test('mediaPut: the placeholder-and-rename path (for a folder that cannot hard-link) is exclusive too', (t) => {
  const e = env(t);
  const dir = path.join(e.mediaDir, 's', 'd');
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(e.tmp, 'victim.txt');
  fs.writeFileSync(victim, 'precious');
  fs.symlinkSync(victim, path.join(dir, 'a.jpg'));
  fs.writeFileSync(path.join(dir, 'b.jpg'), 'mine');
  const r = e.store.mediaPut({ parts: ['s', 'd'], names: ['a.jpg', 'b.jpg', 'c.jpg'], buf: Buffer.from('NEW'), useLink: false });
  assert.equal(r.name, 'c.jpg');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious');
  assert.equal(fs.readFileSync(path.join(dir, 'b.jpg'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(dir, 'c.jpg'), 'utf8'), 'NEW');
  assert.equal(mode(path.join(dir, 'c.jpg')), 0o664);
  assert.deepEqual(names(dir), ['a.jpg', 'b.jpg', 'c.jpg']);
});

test('mediaPut: a failed copy leaves no temp file behind', (t) => {
  const e = env(t);
  assert.throws(() => e.store.mediaPut({ parts: ['s', 'd'], names: ['a.jpg'], file: path.join(e.tmp, 'does-not-exist') }));
  assert.throws(() => e.store.mediaPut({ parts: ['s', 'd'], names: ['a.jpg'], buf: Buffer.from('x'), mode: -1 }));
  const dir = path.join(e.mediaDir, 's', 'd');
  if (fs.existsSync(dir)) assert.deepEqual(names(dir), []);
});

test('mediaList / mediaDirs: links and folders are listed as what they are, never followed', (t) => {
  const e = env(t);
  const dir = path.join(e.mediaDir, 'stills', '2026-01-01');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0900-a.jpg'), 'aaaa');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'n');
  fs.symlinkSync('/etc/hostname', path.join(dir, '0901-link.jpg'));
  fs.mkdirSync(path.join(dir, '0902-dir.jpg'));
  const all = e.store.mediaList(['stills', '2026-01-01']);
  const by = Object.fromEntries(all.map((x) => [x.name, x]));
  assert.equal(by['0900-a.jpg'].isFile, true);
  assert.equal(by['0900-a.jpg'].size, 4);
  assert.equal(by['0901-link.jpg'].isFile, false);
  assert.equal(by['0902-dir.jpg'].isFile, false);
  assert.deepEqual(e.store.mediaList(['stills', '2026-01-01'], { nameRe: /^\d{4}-.*\.jpg$/ }).map((x) => x.name).sort(), ['0900-a.jpg', '0901-link.jpg', '0902-dir.jpg']);
  assert.equal(e.store.mediaList(['stills', '2026-01-01'], { max: 2 }).length, 2);
  assert.match(e.logs.join('\n'), /holds more than 2 entries/);
  fs.mkdirSync(path.join(e.mediaDir, 'stills', '2026-01-02'));
  fs.mkdirSync(path.join(e.mediaDir, 'stills', 'junk'));
  assert.deepEqual(e.store.mediaDirs(['stills']), ['2026-01-01', '2026-01-02']);
  // a day folder that is a link is never entered
  fs.symlinkSync(e.tmp, path.join(e.mediaDir, 'stills', '2026-01-03'));
  assert.deepEqual(e.store.mediaList(['stills', '2026-01-03']), []);
  assert.deepEqual(e.store.mediaList(['nothing', 'here']), []);
});

test('mediaRemove: removes a regular file only; a link, a folder, a name with a slash are left', (t) => {
  const e = env(t);
  const dir = path.join(e.mediaDir, 's', 'd');
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(e.tmp, 'victim.txt');
  fs.writeFileSync(victim, 'precious');
  fs.writeFileSync(path.join(dir, 'f.jpg'), 'x');
  fs.symlinkSync(victim, path.join(dir, 'l.jpg'));
  fs.mkdirSync(path.join(dir, 'dd.jpg'));
  assert.equal(e.store.mediaRemove(['s', 'd'], 'f.jpg'), true);
  assert.equal(e.store.mediaRemove(['s', 'd'], 'l.jpg'), false);
  assert.equal(e.store.mediaRemove(['s', 'd'], 'dd.jpg'), false);
  assert.equal(e.store.mediaRemove(['s', 'd'], '../x'), false);
  assert.equal(e.store.mediaRemove(['s', 'd'], '..'), false);
  assert.equal(e.store.mediaRemove(['s', 'd'], 'missing.jpg'), false);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious');
  assert.deepEqual(names(dir), ['dd.jpg', 'l.jpg']);
  // a file inside a day folder that has been swapped for a link is not removed
  const other = path.join(e.tmp, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'f.jpg'), 'keep');
  fs.rmSync(path.join(e.mediaDir, 's', 'd'), { recursive: true });
  fs.symlinkSync(other, path.join(e.mediaDir, 's', 'd'));
  assert.equal(e.store.mediaRemove(['s', 'd'], 'f.jpg'), false);
  assert.equal(fs.readFileSync(path.join(other, 'f.jpg'), 'utf8'), 'keep');
});

test('mediaRemoveDir: removes an empty folder only; never a link or a folder with files', (t) => {
  const e = env(t);
  const base = path.join(e.mediaDir, 's');
  fs.mkdirSync(path.join(base, 'empty'), { recursive: true });
  fs.mkdirSync(path.join(base, 'full'));
  fs.writeFileSync(path.join(base, 'full', 'f'), 'x');
  const other = path.join(e.tmp, 'other');
  fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(base, 'link'));
  assert.equal(e.store.mediaRemoveDir(['s', 'empty']), true);
  assert.equal(e.store.mediaRemoveDir(['s', 'full']), false);
  assert.equal(e.store.mediaRemoveDir(['s', 'link']), false);
  assert.equal(e.store.mediaRemoveDir([]), false);
  assert.ok(fs.existsSync(other));
  assert.deepEqual(names(base), ['full', 'link']);
});

test('mediaSweepTemp: removes old hidden temp files only', (t) => {
  const e = env(t);
  const dir = path.join(e.mediaDir, 's', 'd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.tmp-1-abc'), 'x');
  fs.writeFileSync(path.join(dir, 'keep.jpg'), 'x');
  e.clock.t = Date.now();   // file times are real
  assert.equal(e.store.mediaSweepTemp(['s', 'd'], 3600000), 0, 'too young');
  const old = new Date(Date.now() - 2 * H);
  fs.utimesSync(path.join(dir, '.tmp-1-abc'), old, old);
  assert.equal(e.store.mediaSweepTemp(['s', 'd'], 3600000), 1);
  assert.deepEqual(names(dir), ['keep.jpg']);
});

test('work files: private folder 0700, unique names', (t) => {
  const e = env(t);
  const a = e.store.workFile('mp4'), b = e.store.workFile('mp4');
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), e.store.workDir);
  assert.equal(mode(e.store.workDir), 0o700);
});

// ── rate buckets ────────────────────────────────────────────────────────────────────────────────────────────

test('rateOk: sliding window; least recently used keys fall out beyond 5000', () => {
  let t = 0;
  const b = createBuckets(() => t);
  for (let i = 0; i < 10; i++) assert.ok(b.rateOk('ip', 10, 60000));
  assert.ok(!b.rateOk('ip', 10, 60000));
  t += 60001;
  assert.ok(b.rateOk('ip', 10, 60000));
  for (let i = 0; i < BUCKET_MAX + 100; i++) b.rateOk(`k${i}`, 1, 60000);
  assert.equal(b.bucketCount(), BUCKET_MAX);
  assert.equal(BUCKET_MAX, 5000);
});

// ── review fixes ────────────────────────────────────────────────────────────────────────────────────────────

test('a media root that is a symlink (or has a trailing slash after one) is refused at open', (t) => {
  const e = env(t);
  const real = path.join(e.tmp, 'real');
  fs.mkdirSync(real);
  const link = path.join(e.tmp, 'link');
  fs.symlinkSync(real, link);
  for (const dir of [link, link + '/']) {
    const s = createStore({ dataHome: e.dataHome, mediaDir: dir, now: () => e.clock.t, log: () => {} });
    assert.throws(() => s.openFolder([], false), (err) => err.code === 'not a plain folder', dir);
    assert.deepEqual(s.mediaList(['x']), []);
  }
  const ok = e.store.openFolder([], false);
  fs.closeSync(ok);
});

test('unreadable state files give ESTATE; absent ones are empty', (t) => {
  const e = env(t);
  assert.equal(e.store.account(), null);
  assert.equal(e.store.unsaved.get(), null);
  assert.equal(e.store.linkArm.get(), null);
  fs.mkdirSync(e.dataHome, { recursive: true });
  for (const [name, call] of [['account.json', () => e.store.account()], ['unsaved.json', () => e.store.unsaved.get()], ['link-arm.json', () => e.store.linkArm.get()]]) {
    fs.writeFileSync(path.join(e.dataHome, name), '{garbled');
    assert.throws(call, (err) => err.code === 'ESTATE', name);
    fs.rmSync(path.join(e.dataHome, name));
  }
  fs.writeFileSync(path.join(e.dataHome, 'state.json'), 'nope');
  assert.throws(() => e.store.acceptEvent('r1', { id: 'r1', at: e.clock.t }), (err) => err.code === 'ESTATE');
  assert.ok(e.logs.every((l) => !/garbled|nope/.test(l)), 'contents are not logged');
});

test('the unreadable-state log is throttled to once a minute per file', (t) => {
  const e = env(t);
  fs.mkdirSync(e.dataHome, { recursive: true });
  fs.writeFileSync(path.join(e.dataHome, 'account.json'), '{garbled');
  const count = () => e.logs.filter((l) => l.startsWith('account.json cannot be read')).length;
  for (let i = 0; i < 5; i++) assert.throws(() => e.store.account(), (err) => err.code === 'ESTATE');
  assert.equal(count(), 1);
  e.clock.t += 61000;
  assert.throws(() => e.store.account(), (err) => err.code === 'ESTATE');
  assert.equal(count(), 2);
});

test('link code: a try that cannot be saved closes the arm in memory; tries are counted in memory too', (t) => {
  const e = env(t);
  const a = e.store.linkArm.arm({ minutes: 30 });
  assert.equal(e.store.linkArm.wrong().closed, false);
  // the disk now refuses writes: put a folder where the arm file's temp/rename target is
  fs.rmSync(path.join(e.dataHome, 'link-arm.json'));
  fs.writeFileSync(path.join(e.dataHome, 'link-arm.json'), JSON.stringify({ id: a.id, salt: 's', codeHash: 'h', expiresAt: e.clock.t + 1e6, tries: 0 }));
  assert.equal(e.store.linkArm.get().tries, 1, 'memory remembers the earlier try although the file says 0');
  fs.chmodSync(e.dataHome, 0o500);
  try {
    const w = e.store.linkArm.wrong();
    if (process.getuid && process.getuid() === 0) return;   // root can write anyway
    assert.equal(w.closed, true);
  } finally { fs.chmodSync(e.dataHome, 0o700); }
  assert.equal(e.store.linkArm.get(), null, 'closed in memory, though the file is still there');
  assert.ok(fs.existsSync(path.join(e.dataHome, 'link-arm.json')));
  const b = e.store.linkArm.arm({ minutes: 30 });
  assert.ok(e.store.linkArm.get() && e.store.linkArm.get().id === b.id, 'a new arm opens again');
});

test("'__proto__' and 'constructor' are ordinary request ids", (t) => {
  const e = env(t);
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.equal(e.store.acceptEvent(id, { id, at: e.clock.t }), 'ok', id);
    assert.equal(e.store.acceptEvent(id, { id, at: e.clock.t }), 'duplicate', id);
  }
  assert.equal(Object.getPrototypeOf(e.store.state().seen), null);
  const again = createStore({ dataHome: e.dataHome, mediaDir: e.mediaDir, now: () => e.clock.t, log: () => {} });
  assert.equal(Object.getPrototypeOf(again.state().seen), null, 'restored without a prototype');
  assert.equal(again.acceptEvent('__proto__', { id: '__proto__', at: e.clock.t }), 'duplicate');
  assert.equal(again.acceptEvent('fresh', { id: 'fresh', at: e.clock.t }), 'ok');
});
