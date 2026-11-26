'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountModelOfferGroups } = require('../lib/ui-model-offer-groups');
const { resolve } = require('../lib/static-files');

class Node {
  constructor(tag) {
    this.tag = tag;
    this.textContent = '';
    this.children = [];
    this.style = {};
  }
  append(node) { this.children.push(node); }
  replaceChildren() { this.children = []; }
  get firstChild() { return this.children[0]; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(event, fn) { this[event] = fn; }
  nodes() { return [this, ...this.children.flatMap(n => n.nodes())]; }
}

const rows = ['<alpha>', 'beta', 'gamma', 'delta'].map(name => ({
  name, from: 'example/v1', to: 'example/v2', route: 'example', cost: 'same subscription'
}));
const group = { id: 'snapshot-1', rows };
function harness() {
  const document = new Node('document');
  document.body = new Node('body');
  document.createElement = tag => new Node(tag);
  const calls = [];
  const win = {
    document, calls, groups: [], status: 200,
    setInterval(fn) { this.poll = fn; },
    async fetch(url, init) {
      calls.push({ url, init });
      const payload = init.method ? { results: this.results } : { groups: this.groups };
      return { ok: this.status === 200, status: this.status, json: async () => payload };
    }
  };
  win.top = win;
  win.nodes = () => document.body.nodes();
  win.button = label => win.nodes().find(n => n.tag === 'button' && n.textContent === label);
  return win;
}

test('both pages load the shared script independent of mode', () => {
  const root = path.resolve(__dirname, '..');
  for (const file of ['index.html', 'mobile.html']) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /<script defer src="\/ui-model-offer-groups\.js"><\/script>/);
  }
  assert.equal(resolve('/ui-model-offer-groups.js', root), path.join(root, 'lib/ui-model-offer-groups.js'));
});

test('discovers while open, shows all rows, applies once and retries only a refreshed offer', async () => {
  const win = harness();
  await mountModelOfferGroups(win);
  assert.equal(win.calls.length, 1);
  win.groups = [group];
  await win.poll();
  for (const row of rows) assert.ok(win.nodes().some(n => n.textContent === row.name));
  assert.equal(win.nodes().filter(n => n.textContent === 'From example/v1 to example/v2').length, 4);
  const apply = win.button('Upgrade all 4 agents');
  await win.poll();
  assert.equal(win.button('Upgrade all 4 agents'), apply);
  win.results = rows.map(({ name }, i) => ({ name, status: ['switched','busy','changed','failed'][i] }));
  win.groups = [{ id: 'snapshot-2', rows: [rows[1]] }];
  await Promise.all([apply.click(), apply.click()]);
  const posts = () => win.calls.filter(c => c.init.method === 'POST');
  assert.deepEqual(posts().map(c => JSON.parse(c.init.body)), [{ id: group.id, action: 'apply' }]);
  for (const fragment of ['<alpha> — Upgraded','beta — Busy','gamma — Changed','delta — Upgrade failed']) {
    assert.ok(win.nodes().some(n => n.textContent.startsWith(fragment)));
  }
  win.results = [{ name: 'beta', status: 'dismissed' }];
  win.groups = [];
  await win.button('Dismiss offer').click();
  assert.deepEqual(JSON.parse(posts()[1].init.body), { id: 'snapshot-2', action: 'dismiss' });
  assert.ok(win.nodes().some(n => n.textContent === 'beta — Offer dismissed'));
  await win.button('Close results').click();
  assert.ok(win.document.body.firstChild.hidden);
});

test('authorization loss on refresh or answer clears offers and names', async () => {
  for (const answer of [false, true]) {
    const win = harness();
    win.groups = [group];
    await mountModelOfferGroups(win);
    win.status = 403;
    if (answer) await win.button('Upgrade all 4 agents').click();
    else await win.poll();
    assert.ok(win.document.body.firstChild.hidden);
    assert.equal(win.nodes().some(n => n.textContent.includes('alpha')), false);
  }
});
