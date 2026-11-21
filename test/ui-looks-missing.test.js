'use strict';
// A page newer than the running server: /ui-looks.js was not served, so window.HubLooks is missing. Settings → Appearance
// (desktop) and the phone's Look sections say how to get the looks instead of showing an empty box.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Cut one function out of a page's source (from "function <name>(" to the closing brace at the same indent).
function cut(src, name, indent) {
  const a = src.indexOf(`${indent}function ${name}(`);
  assert.ok(a >= 0, `${name} found`);
  const end = src.indexOf(`\n${indent}}\n`, a);
  assert.ok(end > a, `${name} ends`);
  return src.slice(a, end + indent.length + 3);
}

function fakeDom() {
  const mk = (tag) => ({
    tag, children: [], className: '', id: '', text: '',
    get firstChild() { return this.children[0] || null; },
    appendChild(n) { this.children.push(n); return n; },
    removeChild(n) { this.children = this.children.filter(c => c !== n); return n; },
    get textContent() { return this.text + this.children.map(c => c.textContent).join(''); },
  });
  const doc = {
    nodes: {},
    createElement: mk,
    createTextNode: (t) => ({ text: String(t), children: [], get textContent() { return this.text; } }),
    getElementById(id) { return this.nodes[id] || null; },
  };
  return { doc, mk };
}

test('desktop Settings → Appearance without the look registry says to restart, never an empty box', () => {
  const src = cut(read('app.js'), 'lookSectionPaint', '    ');
  const { doc, mk } = fakeDom();
  const host = mk('div'); host.appendChild(mk('span'));   // left over from an earlier paint
  doc.nodes['st-looks-body'] = host;
  const win = {};
  new Function('document', 'window', 'isHubAdmin', 'lookPickerBuild', `${src}\nlookSectionPaint({});`)(doc, win, () => true, () => { throw new Error('no picker without a registry'); });
  assert.strictEqual(host.children.length, 1);
  assert.strictEqual(host.textContent, 'Restart your Maestro to load the interface styles.');
  assert.strictEqual(host.children[0].className, 'st-hint');
});

test('phone Look (Profile and Simple sheets) without the look registry says to restart', () => {
  const src = cut(read('mobile.js'), 'lookPickerPaint', '');
  const { doc, mk } = fakeDom();
  const host = mk('div'); host.appendChild(mk('span'));
  new Function('document', 'window', 'host', `${src}\nlookPickerPaint(host);`)(doc, {}, host);
  assert.strictEqual(host.children.length, 1);
  assert.strictEqual(host.textContent, 'Restart your Maestro to load the interface styles.');
  assert.match(host.children[0].className, /\bsec-hint\b/);
});

test('with the registry, both pages still build their pickers (the guard only covers a missing registry)', () => {
  const app = cut(read('app.js'), 'lookSectionPaint', '    ');
  const mob = cut(read('mobile.js'), 'lookPickerPaint', '');
  assert.match(app, /if \(!window\.HubLooks\) \{[\s\S]*?return;\s*\}\s*const picker = document\.createElement\('div'\);/);
  assert.match(mob, /if \(!L\) \{[\s\S]*?return;\s*\}\s*const cur = L\.applied\(document\);/);
});
