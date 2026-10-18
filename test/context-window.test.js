'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cw = require('../lib/context-window');

describe('context window', () => {
  it('a [1m] model has a 1M window; everything else defaults to 200K', () => {
    assert.strictEqual(cw.windowFor('claude-fable-5-1[1m]'), 1000000);
    assert.strictEqual(cw.windowFor('sonnet[1m]'), 1000000);
    // 1M by default (no suffix needed): Fable 5.x, Mythos, Opus 4.7+, Sonnet 5+, Haiku 5.5, and the picker aliases for them
    for (const m of ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-mythos-5-1', 'default', 'opus', 'fable', 'sonnet', 'claude-sdk/claude-fable-5-1', 'claude-sdk/claude-opus-5-5']) assert.strictEqual(cw.windowFor(m), 1000000, String(m));
    // 200K: the 4.5 generation, Opus 4.6 / Sonnet 4.6 without the suffix, the haiku alias (Haiku 4.5), unknown ids
    for (const m of ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-sonnet-4-6', 'haiku', 'gpt-5.6-sol', '', undefined]) assert.strictEqual(cw.windowFor(m), 200000, String(m));
  });

  it('a contextBudget narrows the window, never widens it, and has a floor', () => {
    assert.deepStrictEqual(cw.effectiveWindow('claude-opus-5-5[1m]', 300000), { window: 300000, note: null });
    assert.deepStrictEqual(cw.effectiveWindow('claude-opus-5-5', 150000), { window: 150000, note: null });
    const over = cw.effectiveWindow('claude-sonnet-4-6', 500000);
    assert.strictEqual(over.window, 200000, 'a 200K model cannot be given more than 200K');
    assert.match(over.note, /exceeds/);
    const under = cw.effectiveWindow('claude-opus-5-5', 50000);
    assert.strictEqual(under.window, cw.MIN_BUDGET, 'the SDK will not compact below 100K');
    assert.match(under.note, /minimum/);
    for (const blank of [null, undefined, '', 0, -1, 'lots', NaN]) {
      assert.deepStrictEqual(cw.effectiveWindow('x[1m]', blank), { window: 1000000, note: null }, String(blank));
    }
  });

  it('compacts at 80% of the working window', () => {
    assert.strictEqual(cw.compactAt(1000000), 800000);
    assert.strictEqual(cw.compactAt(300000), 240000);
    assert.strictEqual(cw.compactAt(200000), 160000);
    assert.strictEqual(cw.compactAt(cw.MIN_BUDGET), 100000);
  });

  it('does not ratchet: the window is the same on every turn, whatever the SDK reports', () => {
    // Old bug: SDK echoed the compact window (80%) as maxTokens, the hub stored it as the new
    // window, and the next turn compacted at 80% of that — 1M shrank to 100K over ~11 turns.
    const model = 'claude-opus-5-5[1m]';
    const seen = [];
    for (let turn = 0; turn < 15; turn++) seen.push(cw.compactAt(cw.effectiveWindow(model, null).window));
    assert.ok(seen.every(v => v === 800000), seen.join(','));
    assert.strictEqual(cw.remember, undefined, 'no API left to feed SDK figures back in');
  });

  it('sdk-chat.js derives compaction from the working window only', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');
    assert.ok(!/CONTEXT_LIMIT\s*=\s*contextWindow\.remember/.test(src) && !src.includes('contextWindow.remember('), 'no feedback from getContextUsage().maxTokens');
    assert.ok(!/autoCompactWindow:\s*80000/.test(src), 'no hardcoded 80K compact setting');
    assert.ok(src.includes('contextWindow.effectiveWindow(sdkModel, contextBudget)'));
    assert.ok(src.includes('contextWindow.compactAt(CONTEXT_LIMIT)'));
  });

  it('tells a full context apart from a crash', () => {
    assert.strictEqual(cw.classifyExit({ message: 'Claude Code process exited with code 1', usedTokens: 299164, limit: 1000000 }).kind, 'crash', 'exit 1 at 30% is not a full window');
    assert.strictEqual(cw.classifyExit({ message: 'Claude Code process exited with code 1', usedTokens: 190000, limit: 200000 }).kind, 'context', '95% usage is');
    assert.strictEqual(cw.classifyExit({ message: '400 prompt is too long: 202631 tokens > 200000 maximum', usedTokens: 0 }).kind, 'context', "the API's own wording is");
    assert.strictEqual(cw.classifyExit({ message: 'ECONNRESET' }).kind, 'crash');
  });

  it('labels read naturally in a prompt', () => {
    assert.deepStrictEqual([200000, 1000000, 128000, undefined].map(cw.label), ['200K', '1M', '128K', '200K']);
  });

  it('sdk-chat.js no longer hardcodes a 200K window', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');
    assert.ok(!/CONTEXT_LIMIT\s*=\s*200000/.test(src), 'CONTEXT_LIMIT must come from lib/context-window.js');
    assert.ok(!src.includes('(~200K tokens)'), 'the agent prompt must state the real window');
    assert.ok(src.includes('contextWindow.label(CONTEXT_LIMIT)'));
  });
});
