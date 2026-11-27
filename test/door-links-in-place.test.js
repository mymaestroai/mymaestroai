'use strict';
// A chat link to one of the hub's own doors (an agent's card at a row, a Settings row or group) opens in place in one press:
// no new tab. Other links still open in a new tab. (The browser proof checks the click itself.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const DOOR = /^\/(?:mobile)?#(?:agent-card|settings-for|settings-group)=/;

test('the desktop chat renderer writes door links without target=_blank, other links with it', () => {
  const app = read('app.js');
  const at = app.indexOf('const inPlace = !!u && /^\\/(?:mobile)?#(?:agent-card|settings-for|settings-group)=/.test(u);');
  assert.ok(at > 0, 'the in-place test is in the renderer');
  const block = app.slice(at, at + 700);
  assert.match(block, /inPlace\s*\?\s*`<a href="\$\{escapeHtml\(u\.replace\(\/\^\\\/mobile#\/, '\/#'\)\)\}" data-door="1"/);
  assert.match(block, /: `<a href="\$\{escapeHtml\(u\)\}" target="_blank" rel="noopener noreferrer"/);
});

test('the phone chat renderer writes door links in place on /mobile, other links in a new tab', () => {
  const mob = read('mobile.js');
  const at = mob.indexOf('const inPlace = !!u && /^\\/(?:mobile)?#(?:agent-card|settings-for|settings-group)=/.test(u);');
  assert.ok(at > 0, 'the in-place test is in the renderer');
  const block = mob.slice(at, at + 500);
  assert.match(block, /inPlace \? `<a href="\$\{esc\(u\.replace\(\/\^\\\/#\/, '\/mobile#'\)\)\}" data-door="1">/);
  assert.match(block, /`<a href="\$\{esc\(u\)\}" target="_blank" rel="noopener noreferrer">/);
});

test('which links count as doors', () => {
  for (const u of ['/#agent-card=hazel&row=OPT-0053', '/mobile#agent-card=hazel', '/#settings-for=OPT-0129', '/#settings-group=review']) assert.ok(DOOR.test(u), u);
  for (const u of ['https://example.com/#agent-card=x', '/users', '/#ask-lead=hi', '//example.com/#agent-card=x', 'javascript:alert(1)']) assert.ok(!DOOR.test(u), u);
});
