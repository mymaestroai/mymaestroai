'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { accumulateToolCallDelta } = require('../lib/tool-call-deltas');
const { quirks } = require('../lib/model-quirks');

const fold = (deltas) => { const m = new Map(); for (const tc of deltas) accumulateToolCallDelta(m, tc); return [...m.values()]; };

describe('tool-call deltas', () => {
  it('Gemini: parallel calls arrive whole, with no index, and stay separate', () => {
    // Shape captured live from gemini-pro-latest and gemini-flash-latest on 2026-09-21.
    const calls = fold([
      { id: 'call_92548', type: 'function', function: { name: 'web_search', arguments: '{"query":"momentum crypto"}' }, extra_content: { google: { thought_signature: 'SIG' } } },
      { id: 'call_92553', type: 'function', function: { name: 'web_search', arguments: '{"query":"impermanent loss study"}' } },
      { id: 'call_92554', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/a.json"}' } },
    ]);
    assert.deepStrictEqual(calls.map(c => c.name), ['web_search', 'web_search', 'read_file']);
    assert.deepStrictEqual(calls.map(c => c.id), ['call_92548', 'call_92553', 'call_92554']);
    for (const c of calls) assert.doesNotThrow(() => JSON.parse(c.arguments), `arguments of ${c.id} must be valid JSON`);
    assert.deepStrictEqual(calls[0].extra_content, { google: { thought_signature: 'SIG' } });
    assert.strictEqual(calls[1].extra_content, undefined);
  });

  it('OpenAI: fragments sharing an index build one call; id appears only on the first', () => {
    const calls = fold([
      { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '' } },
      { index: 0, function: { arguments: '{"pa' } },
      { index: 1, id: 'call_b', function: { name: 'web_search', arguments: '{"query":' } },
      { index: 0, function: { arguments: 'th":"/x"}' } },
      { index: 1, function: { arguments: '"y"}' } },
    ]);
    assert.deepStrictEqual(calls, [
      { id: 'call_a', name: 'read_file', arguments: '{"path":"/x"}' },
      { id: 'call_b', name: 'web_search', arguments: '{"query":"y"}' },
    ]);
  });

  it('no index: a fragment without an id continues the most recent call', () => {
    const calls = fold([
      { id: 'c1', function: { name: 'read_file', arguments: '{"path":' } },
      { function: { arguments: '"/x"}' } },
      { id: 'c2', function: { name: 'read_file', arguments: '{"path":"/y"}' } },
      { id: 'c1', function: { arguments: '' } },
    ]);
    assert.deepStrictEqual(calls.map(c => [c.id, c.arguments]), [['c1', '{"path":"/x"}'], ['c2', '{"path":"/y"}']]);
  });

  it('no index and no id at all still yields a call', () => {
    const calls = fold([{ function: { name: 'read_file', arguments: '{}' } }]);
    assert.deepStrictEqual(calls, [{ id: '', name: 'read_file', arguments: '{}' }]);
  });
});

describe('model quirks: which OpenAI models need /v1/responses for tools', () => {
  it('routes the gpt-5.6 family to the Responses API', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-luna', 'openai/gpt-5.6-sol', 'gpt-5.6-terra']) {
      const q = quirks(m);
      assert.strictEqual(q.api, 'responses', m);
      assert.ok(q.drop.includes('temperature'), `${m} keeps the reasoning-model parameter rules`);
    }
  });
  it('leaves models that accept tools on chat/completions alone', () => {
    for (const m of ['gpt-5.5', 'gpt-5.4-mini', 'o3', 'gpt-5', 'gemini-pro-latest']) assert.strictEqual(quirks(m).api, 'chat', m);
  });
});
