'use strict';
// Simple's theme button cycle and its agent groups (Primary shown; Specialists / Helpers under "More agents").
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/ui-simple.js');

test('nextTheme cycles Light -> Dark -> Match device -> Light; unknown counts as Match device', () => {
  assert.strictEqual(S.nextTheme('light'), 'dark');
  assert.strictEqual(S.nextTheme('dark'), 'auto');
  assert.strictEqual(S.nextTheme('auto'), 'light');
  assert.strictEqual(S.nextTheme(undefined), 'light');
  assert.strictEqual(S.nextTheme('neon'), 'light');
});

test('themeLabel names each theme in plain words with a symbol', () => {
  assert.deepStrictEqual(S.themeLabel('light'), { icon: '☀', label: 'Light' });
  assert.deepStrictEqual(S.themeLabel('dark'), { icon: '☾', label: 'Dark' });
  assert.deepStrictEqual(S.themeLabel(null), { icon: '◐', label: 'Match device' });
});

test('agentGroups: Primary agents first; Specialists, Helpers and Experimental under More, in that order, empty groups left out', () => {
  const list = [
    { name: 'lead', category: 'primary' }, { name: 'doc', category: 'specialist' },
    { name: 'w1', category: 'worker' }, { name: 'guide', category: 'primary' }, { name: 'x', category: 'experimental' },
  ];
  const g = S.agentGroups(list);
  assert.deepStrictEqual(g.primary.map((a) => a.name), ['lead', 'guide']);
  assert.deepStrictEqual(g.more.map((m) => [m.label, m.items.map((a) => a.name)]), [['Specialists', ['doc']], ['Helpers', ['w1']], ['Experimental', ['x']]]);
  assert.deepStrictEqual(S.agentGroups([{ name: 'a', category: 'primary' }, { name: 'b', category: 'worker' }]).more.map((m) => m.label), ['Helpers']);
});

test('agentGroups: with no Primary agent, everything shows and nothing is folded away', () => {
  const g = S.agentGroups([{ name: 'helper', category: 'specialist' }, { name: 'guide' }]);
  assert.deepStrictEqual(g.primary.map((a) => a.name), ['helper', 'guide']);
  assert.deepStrictEqual(g.more, []);
  assert.deepStrictEqual(S.agentGroups([]), { primary: [], more: [] });
  assert.deepStrictEqual(S.agentGroups(null), { primary: [], more: [] });
});

test('agentGroups: a missing category counts as specialist, an unknown one joins Specialists; a custom category reader is used', () => {
  const g = S.agentGroups([{ name: 'p', category: 'primary' }, { name: 'n' }, { name: 'odd', category: 'team' }]);
  assert.deepStrictEqual(g.more.map((m) => [m.label, m.items.map((a) => a.name)]), [['Specialists', ['n', 'odd']]]);
  const h = S.agentGroups([{ name: 'p', k: 'primary' }, { name: 'q', k: 'worker' }], (a) => a.k);
  assert.deepStrictEqual(h.more.map((m) => m.label), ['Helpers']);
});

test('MORE_KEY is the per-device storage key', () => {
  assert.strictEqual(S.MORE_KEY, 'hub-simple-more');
});
