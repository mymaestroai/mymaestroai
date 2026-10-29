'use strict';
// The chat fills the window at every width (no fixed 1200px column), the composer stays in the same column, and wide
// content (tables, code, long URLs, images, visuals) scrolls or wraps inside its message instead of moving the page
// sideways, on the desktop page and on the phone. A later "limit the width" setting only has to set --chat-max-width.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('index.html'), mhtml = read('mobile.html'), app = read('app.js');
const rule = (src, sel) => { const i = src.indexOf(`${sel} {`); assert.ok(i >= 0, `${sel} rule`); return src.slice(i, src.indexOf('}', i)); };

test('desktop: no 1200px cap; messages and composer share --chat-max-width (none) and the fluid side padding', () => {
  assert.ok(!/max-width:\s*1200px/.test(html), 'no 1200px cap left');
  assert.match(html, /--chat-max-width: none;/);
  assert.match(html, /--chat-pad-x: clamp\(12px, 2vw, 32px\);/);
  const m = rule(html, '    .messages'), i = rule(html, '    .input-area');
  for (const [name, r] of [['.messages', m], ['.input-area', i]]) {
    assert.match(r, /max-width: var\(--chat-max-width\);?/, `${name} follows the variable`);
    assert.match(r, /var\(--chat-pad-x\)/, `${name} uses the same side padding`);
  }
  assert.match(m, /overflow-x: hidden;/, 'the chat never scrolls sideways');
  assert.match(m, /min-width: 0;/);
});

test('desktop: wide content stays inside its message', () => {
  assert.match(html, /\n    \.message \{\n      max-width: 100%; min-width: 0; margin-bottom: 20px; overflow-wrap: anywhere;/, 'long URLs and words wrap');
  assert.match(html, /\.message \.table-scroll \{ max-width: 100%; overflow-x: auto;/);
  assert.match(app, /let tableHtml = '<div class="table-scroll"><table><thead><tr>';/);
  assert.match(app, /tableHtml \+= '<\/tbody><\/table><\/div>';/);
  assert.match(html, /\.message pre \{ max-width: 100%; \}/);
  assert.match(html, /\.message img, \.message video, \.message svg \{ max-width: 100%; \}/);
  assert.match(html, /\.message th, \.message td \{ overflow-wrap: normal; \}/, 'cells keep whole words; the table scrolls');
});

test('desktop phone width: messages use the full width', () => {
  assert.ok(!/\.message \{ max-width: 95%; \}/.test(html));
  assert.match(html, /\.message \{ max-width: 100%; \}/);
});

test('phone page: the chat scroller is vertical only; bubbles and their contents never widen it', () => {
  assert.match(rule(mhtml, '    .scroll'), /overflow-y: auto; overflow-x: hidden;/);
  assert.match(rule(mhtml, '    #messages'), /min-width: 0;/);
  assert.match(rule(mhtml, '    .msg'), /min-width: 0;/);
  assert.match(mhtml, /\.msg\.assistant pre, \.msg\.assistant table, \.msg\.assistant \.visual \{ max-width: 100%; \}/);
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v60';/, 'service worker cache bumped');
});

test('phone (desktop page, ≤768px): the ☰ has its own row; icons on row 1, open agents on row 2 scrolling inside it', () => {
  const at = html.indexOf('/* Enhanced mobile (phone) experience */');
  const phone = html.slice(at, html.indexOf('\n    }\n', at));
  assert.match(phone, /\.sidebar-header \{ padding-top: 54px; \}/, 'title and version start below the ☰ (10px + 34px + gap)');
  assert.match(phone, /\.main-header \{ padding: 10px 10px 0 10px; \}/);
  assert.match(phone, /\.main-header-top \{ flex-wrap: wrap;[^}]*min-width: 0;/);
  assert.match(phone, /\.main-header-top \.header-controls \{ order: 1; flex: 1 0 100%; min-height: 36px; justify-content: flex-end; padding-left: 46px;/, 'icons clear of the ☰');
  assert.match(phone, /\.main-header-top \.header-btn \{ min-width: 36px; min-height: 36px;/, 'tap targets ≥ 36px');
  assert.match(phone, /\.main-header-top #more-btn \{ min-width: 36px; \}/, '⋯ too (its own rule is 32px)');
  assert.match(phone, /\.main-header-top \.active-chats \{ order: 2; flex: 1 0 100%; min-width: 0; max-width: 100%;/, 'agents on their own row');
  assert.match(html, /@media \(max-width: 1024px\) \{[\s\S]*?\.active-chats \{\s*display: flex; flex-wrap: nowrap; gap: 6px;\s*overflow-x: auto;/, 'the row scrolls sideways (existing rule)');
});
