'use strict';
// The desktop page describes itself as an app (icons/desktop.webmanifest), so Chrome/Edge "Install page as app" and
// Safari "Add to Dock" make a "My Maestro AI" app with the Maestro icon that opens the desktop layout. The phone app
// keeps its own manifest (/manifest.json → /mobile.html). Browsers fetch a manifest without cookies, so it must be public.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resolve } = require('../lib/static-files');
const { classifyRoute } = require('../lib/access');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = '/icons/desktop.webmanifest';
const read = rel => fs.readFileSync(path.join(ROOT, rel.replace(/^\//, '')), 'utf8');

function pngSize(rel) {          // width and height from the PNG header (IHDR), so a declared size can't drift from the file
  const b = fs.readFileSync(path.join(ROOT, rel.replace(/^\//, '')));
  assert.strictEqual(b.toString('latin1', 1, 4), 'PNG', rel + ' is a PNG');
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

test('the desktop manifest opens the desktop layout as a standalone app named My Maestro AI', () => {
  const m = JSON.parse(read(MANIFEST));
  assert.strictEqual(m.name, 'My Maestro AI');
  assert.strictEqual(m.start_url, '/');
  assert.strictEqual(m.scope, '/');
  assert.strictEqual(m.id, '/');
  assert.strictEqual(m.display, 'standalone');
});

test('its icons exist, are PNGs of the declared sizes, and include 192 and 512 (what Chrome needs to install)', () => {
  const m = JSON.parse(read(MANIFEST));
  const sizes = m.icons.map(i => {
    assert.strictEqual(i.type, 'image/png', i.src);
    assert.strictEqual(pngSize(i.src), i.sizes, i.src + ' declared size matches the file');
    assert.ok(resolve(i.src), i.src + ' is served');
    return i.sizes;
  });
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'has 192x192 and 512x512');
});

test('the desktop page links the manifest and an Apple touch icon; the phone app keeps its own manifest', () => {
  const html = read('/index.html');
  assert.match(html, /<link rel="manifest" href="\/icons\/desktop\.webmanifest">/);
  const touch = html.match(/<link rel="apple-touch-icon" href="([^"]+)">/);
  assert.ok(touch && resolve(touch[1]), 'apple-touch-icon points at a served file');
  assert.match(read('/mobile.html'), /<link rel="manifest" href="\/manifest\.json">/);
  assert.strictEqual(JSON.parse(read('/manifest.json')).start_url, '/mobile.html', 'the phone app still opens the phone layout');
});

test('the manifest is served and public, since browsers fetch it without the sign-in cookie', () => {
  const r = resolve(MANIFEST);
  assert.ok(r && r.endsWith(path.join('icons', 'desktop.webmanifest')), 'served from icons/');
  assert.deepStrictEqual(classifyRoute(MANIFEST), { kind: 'public' });
});
