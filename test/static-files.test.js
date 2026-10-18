'use strict';
// lib/static-files: the allow-list behind server.js's static fallback. Only the UI's pages and assets are web
// resources; everything else under the install folder is not, in any spelling, and symlinks may not leave the install.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolve, TOP_FILES, DIRS } = require('../lib/static-files');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-files-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'static-outside-'));
  for (const d of ['vendor', 'icons', 'images', 'data', 'lib', 'docs', 'workspaces/maestro']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ['app.js', 'mobile.js', 'index.html', 'agent-settings.html', 'manifest.json', 'favicon.svg', 'vendor/purify.min.js', 'icons/hub-192.png', 'images/tiger-logo.svg',
    'data/users.json', 'lib/auth.js', '.env', 'server.log', 'agent-hub-5.1.0.tar.gz', 'README.md', 'docs/HUB-MAP.md', 'workspaces/maestro/SOUL.md', 'vendor/.hidden.js', 'vendor/notes.md', 'package.json']) {
    fs.writeFileSync(path.join(root, f), 'x');
  }
  fs.writeFileSync(path.join(outside, 'secret.js'), 'x');
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(root, 'vendor', 'escape.js'));
  fs.symlinkSync(path.join(root, 'app.js'), path.join(root, 'vendor', 'inside.js'));
  return { root, outside };
}

test('allow-listed pages and assets resolve to the real file inside the install', () => {
  const { root } = fixture();
  for (const p of ['/app.js', '/mobile.js', '/index.html', '/agent-settings.html', '/manifest.json', '/favicon.svg', '/vendor/purify.min.js', '/icons/hub-192.png', '/images/tiger-logo.svg', 'vendor/purify.min.js', '//app.js', '/vendor/./purify.min.js']) {
    const r = resolve(p, root);
    assert.ok(r && r.startsWith(fs.realpathSync(root) + path.sep), p);
    assert.ok(fs.statSync(r).isFile(), p);
  }
  assert.strictEqual(resolve('/vendor/inside.js', root), fs.realpathSync(path.join(root, 'app.js')), 'a symlink that stays inside the install is fine');
  assert.ok(TOP_FILES.has('sw.js') && TOP_FILES.has('login.html') && DIRS.has('vendor'));
});

test('nothing else is a web resource: dotfiles, data/, lib/, workspaces/, docs, logs, tarballs, package.json, traversal in any spelling', () => {
  const { root } = fixture();
  for (const p of ['/.env', '/data/users.json', '/lib/auth.js', '/workspaces/maestro/SOUL.md', '/docs/HUB-MAP.md', '/server.log', '/agent-hub-5.1.0.tar.gz', '/README.md', '/package.json',
    '/vendor/.hidden.js', '/vendor/notes.md', '/vendor/../.env', '/icons/..%2f..%2f.env', '/%2e%2e/.env', '/vendor/%2e%2e/data/users.json', '/..\\.env', '/vendor\\..\\.env', '/app.js%00.png', '/', '', '/vendor', '/vendor/', '/icons/', '/nope.js', '/vendor/missing.js']) {
    assert.strictEqual(resolve(p, root), null, p);
  }
});

test('a symlink that leaves the install folder is refused even under an allowed folder and extension', () => {
  const { root, outside } = fixture();
  assert.strictEqual(resolve('/vendor/escape.js', root), null);
  assert.ok(fs.existsSync(path.join(outside, 'secret.js')), 'the target itself is untouched');
});

test('the real install root is the default and serves the hub\'s own app.js', () => {
  const r = resolve('/app.js');
  assert.ok(r && r.endsWith(path.sep + 'app.js'));
  assert.strictEqual(resolve('/.env'), null);
  assert.strictEqual(resolve('/data/settings.json'), null);
  assert.strictEqual(resolve('/lib/auth.js'), null);
});
