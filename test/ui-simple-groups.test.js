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
  assert.deepStrictEqual(g.primary.map((a) => a.name), ['guide', 'lead']);   // alphabetical (no lead flag here)
  assert.deepStrictEqual(g.more.map((m) => [m.label, m.items.map((a) => a.name)]), [['Specialists', ['doc']], ['Helpers', ['w1']], ['Experimental', ['x']]]);
  assert.deepStrictEqual(S.agentGroups([{ name: 'a', category: 'primary' }, { name: 'b', category: 'worker' }]).more.map((m) => m.label), ['Helpers']);
});

test('agentGroups: with no Primary agent, everything shows and nothing is folded away', () => {
  const g = S.agentGroups([{ name: 'helper', category: 'specialist' }, { name: 'guide' }]);
  assert.deepStrictEqual(g.primary.map((a) => a.name), ['guide', 'helper']);
  assert.deepStrictEqual(g.more, []);
  assert.deepStrictEqual(S.agentGroups([]), { primary: [], more: [] });
  assert.deepStrictEqual(S.agentGroups(null), { primary: [], more: [] });
});

test('agentGroups: the lead agent comes first, then the rest alphabetically by the name shown (case-insensitive)', () => {
  const g = S.agentGroups([
    { name: 'zeta', display: 'Zeta', category: 'primary' }, { name: 'boss', display: 'Maestro', category: 'primary', lead: true },
    { name: 'b', display: 'biographer', category: 'primary' }, { name: 'c', display: 'CNC', category: 'primary' },
    { name: 'h2', display: 'Helper B', category: 'worker' }, { name: 'h1', display: 'Helper A', category: 'worker' },
  ]);
  assert.deepStrictEqual(g.primary.map((a) => a.display), ['Maestro', 'biographer', 'CNC', 'Zeta']);
  assert.deepStrictEqual(g.more[0].items.map((a) => a.display), ['Helper A', 'Helper B']);
});

test('agentGroups: a lead agent filed under another category is still shown first, never folded away', () => {
  const g = S.agentGroups([{ name: 'p', category: 'primary' }, { name: 'boss', category: 'specialist', lead: true }, { name: 's', category: 'specialist' }]);
  assert.deepStrictEqual(g.primary.map((a) => a.name), ['boss', 'p']);
  assert.deepStrictEqual(g.more.map((m) => [m.label, m.items.map((a) => a.name)]), [['Specialists', ['s']]]);
});

test('agentGroups does not reorder the list it was given', () => {
  const list = [{ name: 'b', category: 'primary' }, { name: 'a', category: 'primary' }];
  S.agentGroups(list);
  assert.deepStrictEqual(list.map((a) => a.name), ['b', 'a']);
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
