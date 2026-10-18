'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const tw = require('../lib/temporal-workers');

const AVAILABLE = [
  'claude-sdk/default', 'claude-sdk/opus[1m]', 'claude-sdk/claude-fable-5-1', 'claude-sdk/claude-fable-5-1[1m]', 'claude-sdk/claude-fable-5',
  'claude-sdk/claude-opus-5', 'claude-sdk/claude-opus-4-6', 'claude-sdk/claude-sonnet-5', 'claude-sdk/claude-haiku-4-5-20251001',
  'openai/gpt-4.1', 'openai/gpt-5', 'openai/gpt-5.4', 'openai/gpt-5.4-mini', 'openai/gpt-5-2025-08-07', 'openai/gpt-4o-audio-preview', 'openai/o4-mini',
  'google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-preview-tts', 'google/gemini-pro-latest',
  'perplexity/sonar-pro', 'perplexity/sonar', 'codex/gpt-5',
  'lmstudio/qwen/qwen3.6-27b',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('temporal workers: virtual agents', () => {
  it('creates unique ids that never collide, and releases them', () => {
    const a = tw.createVirtual({ parent: 'maestro', model: 'openai/gpt-5.4' });
    const b = tw.createVirtual({ parent: 'maestro', model: 'openai/gpt-5.4' });
    assert.notStrictEqual(a.id, b.id);
    assert.match(a.id, /^tw-maestro-\d+-[0-9a-f]{4}$/);
    assert.ok(tw.isVirtual(a.id)); assert.strictEqual(tw.getVirtual(a.id).model, 'openai/gpt-5.4');
    tw.releaseVirtual(a.id); tw.releaseVirtual(b.id);
    assert.ok(!tw.isVirtual(a.id)); assert.strictEqual(tw.getVirtual(a.id), null);
  });
  it('worker context states scope, no delegation, and who the reply goes to', () => {
    const ro = tw.workerContext({ parent: 'maestro', toolScope: 'read', label: 'scan logs' });
    assert.match(ro, /READ-ONLY/); assert.match(ro, /cannot delegate/); assert.match(ro, /"maestro"/); assert.match(ro, /scan logs/);
    assert.match(tw.workerContext({ parent: 'x', toolScope: 'full' }), /may read, write and run commands/);
    assert.match(tw.workerContext({ parent: 'x', toolScope: 'none' }), /no tools/);
  });
});

describe('temporal workers: model choice', () => {
  it('shortlist drops aliases, dated snapshots and non-chat variants, newest first, one Claude per family', () => {
    const ids = tw.curateCatalog(AVAILABLE, []).map(c => c.id);
    for (const bad of ['claude-sdk/default', 'claude-sdk/opus[1m]', 'claude-sdk/claude-fable-5-1[1m]', 'openai/gpt-5-2025-08-07', 'openai/gpt-4o-audio-preview', 'google/gemini-2.5-flash-preview-tts'])
      assert.ok(!ids.includes(bad), `${bad} should not be in the shortlist`);
    assert.ok(ids.includes('claude-sdk/claude-fable-5-1')); assert.ok(!ids.includes('claude-sdk/claude-fable-5'), 'older Fable dropped');
    assert.ok(ids.includes('claude-sdk/claude-opus-5')); assert.ok(!ids.includes('claude-sdk/claude-opus-4-6'));
    assert.ok(ids.includes('claude-sdk/claude-haiku-4-5-20251001'), 'a family whose only id is dated is still kept');
    assert.ok(ids.indexOf('openai/gpt-5.4') < ids.indexOf('openai/gpt-5'), 'newer first');
    assert.ok(ids.includes('lmstudio/qwen/qwen3.6-27b')); assert.ok(ids.includes('codex/gpt-5'));
  });
  it('notes are honest about what each path can do', () => {
    assert.match(tw.noteFor('claude-sdk/claude-sonnet-5'), /full Claude Code harness/);
    assert.match(tw.noteFor('codex/gpt-5'), /TEXT-ONLY/);
    assert.match(tw.noteFor('perplexity/sonar-pro'), /no file tools/);
    assert.match(tw.noteFor('lmstudio/x'), /LOCAL/);
  });
  it('resolves exact, case-insensitive and unambiguous bare ids; rejects unknown and ambiguous', () => {
    assert.strictEqual(tw.resolveModel('google/gemini-2.5-pro', AVAILABLE).model, 'google/gemini-2.5-pro');
    assert.strictEqual(tw.resolveModel('GOOGLE/Gemini-2.5-Pro', AVAILABLE).model, 'google/gemini-2.5-pro');
    assert.strictEqual(tw.resolveModel('sonar-pro', AVAILABLE).model, 'perplexity/sonar-pro');
    assert.match(tw.resolveModel('gpt-5', AVAILABLE).error, /ambiguous/);                 // openai/gpt-5 and codex/gpt-5
    assert.match(tw.resolveModel('openai/gpt-9', AVAILABLE).error, /not reachable/);
    assert.match(tw.resolveModel('lmstudio/llama', AVAILABLE).error, /not reachable/);    // LM Studio model that is not loaded
  });
  it('defaults to the calling agent\'s model when none is given', () => {
    const r = tw.resolveModel('', AVAILABLE, 'claude-sdk/claude-fable-5-1');
    assert.strictEqual(r.model, 'claude-sdk/claude-fable-5-1'); assert.strictEqual(r.defaulted, true);
    assert.match(tw.resolveModel('', AVAILABLE, '').error, /no model given/);
  });
});

describe('temporal workers: job validation', () => {
  const opts = { available: AVAILABLE, callerModel: 'claude-sdk/claude-sonnet-5' };
  it('accepts a mixed-model batch and applies the default scope', () => {
    const { jobs } = tw.normalizeJobs([
      { task: 'Summarise lib/agents.js in five bullets.', model: 'google/gemini-2.5-pro' },
      { task: 'List every TODO under lib/ with file and line.', model: 'claude-sdk/claude-haiku-4-5-20251001', tools: 'read', label: 'todo sweep' },
      { task: 'Refactor test/unit.test.js helper into its own file.', tools: 'full' },
    ], opts);
    assert.deepStrictEqual(jobs.map(j => j.provider), ['google', 'claude-sdk', 'claude-sdk']);
    assert.deepStrictEqual(jobs.map(j => j.toolScope), [tw.DEFAULT_SCOPE, 'read', 'full']);
    assert.strictEqual(jobs[2].model, 'claude-sdk/claude-sonnet-5'); assert.strictEqual(jobs[2].defaulted, true);
    assert.strictEqual(jobs[1].label, 'todo sweep'); assert.strictEqual(jobs[0].label, 'worker 1');
  });
  it('text-only providers are forced to no tools, with a note', () => {
    const { jobs } = tw.normalizeJobs([{ task: 'Review this diff for logic errors: ...', model: 'codex/gpt-5', tools: 'full' }], opts);
    assert.strictEqual(jobs[0].toolScope, 'none'); assert.match(jobs[0].note, /cannot use tools/);
  });
  it('rejects the WHOLE batch on any bad job, so nothing half-runs', () => {
    const r = tw.normalizeJobs([{ task: 'A perfectly fine and complete brief.' }, { task: 'short' }, { task: 'Another complete brief here.', model: 'openai/gpt-9' }, { task: 'Yet another complete brief.', tools: 'root' }], opts);
    assert.match(r.error, /Nothing was run/); assert.match(r.error, /worker 2/); assert.match(r.error, /worker 3/); assert.match(r.error, /worker 4/);
    assert.strictEqual(r.jobs, undefined);
  });
  it('enforces the per-call ceiling and input shape', () => {
    const many = Array.from({ length: tw.MAX_WORKERS_PER_CALL + 1 }, () => ({ task: 'A complete self-contained brief.' }));
    assert.match(tw.normalizeJobs(many, opts).error, /too many workers/);
    assert.match(tw.normalizeJobs([], opts).error, /non-empty array/);
    assert.match(tw.normalizeJobs('nope', opts).error, /non-empty array/);
  });
});

describe('temporal workers: tool scope', () => {
  it('workers can never nest, on either path, in any scope', () => {
    for (const s of ['read', 'full']) {
      for (const t of ['consult_agent', 'spawn_workers', 'create_agent', 'start_tiger_team']) assert.ok(tw.gatewayExcludesFor(s).includes(t), `${s}/${t}`);
      for (const t of ['Agent', 'Task']) assert.ok(tw.sdkDisallowedFor(s).includes(t), `${s}/${t}`);
    }
  });
  it('read scope blocks writing; full scope does not', () => {
    for (const t of ['Bash', 'Write', 'Edit']) { assert.ok(tw.gatewayExcludesFor('read').includes(t)); assert.ok(tw.sdkDisallowedFor('read').includes(t)); assert.ok(!tw.gatewayExcludesFor('full').includes(t)); assert.ok(!tw.sdkDisallowedFor('full').includes(t)); }
    assert.ok(!tw.sdkDisallowedFor('read').includes('Read')); assert.ok(tw.sdkDisallowedFor('none').includes('Read'));
  });
});

describe('temporal workers: running', () => {
  const job = (i, provider, model) => ({ index: i, task: 't', model: model || provider + '/m', provider, toolScope: 'read', label: 'w' + i });

  it('runs in parallel, returns in input order, and releases every virtual agent', async () => {
    const seen = [];
    const res = await tw.runWorkers([job(1, 'openai'), job(2, 'google'), job(3, 'claude-sdk')], {
      parent: 'maestro', limiter: new tw.ProviderLimiter(),
      runOne: async (j, v) => { seen.push(v.id); assert.ok(tw.isVirtual(v.id)); await sleep(j.index === 1 ? 60 : 10); return 'done ' + j.index; },
    });
    assert.deepStrictEqual(res.map(r => r.text), ['done 1', 'done 2', 'done 3']);
    assert.ok(res.every(r => r.ok)); assert.strictEqual(new Set(seen).size, 3);
    for (const id of seen) assert.ok(!tw.isVirtual(id), 'released');
  });

  it('one failure does not sink the batch', async () => {
    const res = await tw.runWorkers([job(1, 'openai'), job(2, 'google')], { parent: 'm', limiter: new tw.ProviderLimiter(),
      runOne: async (j) => { if (j.index === 1) throw new Error('provider 503'); return 'fine'; } });
    assert.strictEqual(res[0].ok, false); assert.match(res[0].text, /FAILED: provider 503/);
    assert.strictEqual(res[1].ok, true);
    assert.strictEqual(tw.listVirtual().filter(v => v.parent === 'm').length, 0, 'failed worker is released too');
  });

  it('caps concurrency per provider: a local server runs one at a time, hosted ones overlap', async () => {
    let localNow = 0, localPeak = 0, hostedNow = 0, hostedPeak = 0;
    const jobs = [job(1, 'lmstudio'), job(2, 'lmstudio'), job(3, 'lmstudio'), job(4, 'openai'), job(5, 'openai'), job(6, 'openai')];
    await tw.runWorkers(jobs, { parent: 'm', limiter: new tw.ProviderLimiter(), runOne: async (j) => {
      if (j.provider === 'lmstudio') { localPeak = Math.max(localPeak, ++localNow); await sleep(25); localNow--; }
      else { hostedPeak = Math.max(hostedPeak, ++hostedNow); await sleep(25); hostedNow--; }
      return 'ok';
    } });
    assert.strictEqual(localPeak, 1); assert.strictEqual(hostedPeak, 3);
  });

  it('formats a combined report the caller can act on', () => {
    const out = tw.formatResults([
      { label: 'scan', model: 'google/gemini-2.5-pro', toolScope: 'read', ok: true, secs: 3.21, text: 'found 2 issues' },
      { label: 'review', model: 'codex/gpt-5', toolScope: 'none', ok: false, secs: 1, text: 'FAILED: timeout', note: 'codex/gpt-5 cannot use tools; running text-only', defaulted: false },
    ]);
    assert.match(out, /^2 temporary worker\(s\) finished: 1 succeeded, 1 failed/);
    assert.match(out, /===== scan \| google\/gemini-2.5-pro \| tools: read \| ok \| 3.2s =====\nfound 2 issues/);
    assert.match(out, /FAILED \| 1.0s =====\n\[note: codex/);
  });

  it('tool description carries the live catalog and the rules', () => {
    const d = tw.toolDescription(tw.describeCatalog(tw.curateCatalog(AVAILABLE, []), AVAILABLE.length));
    assert.match(d, /model YOU choose/); assert.match(d, /google\/gemini-2.5-pro/); assert.match(d, /uses your own model/); assert.match(d, /any exact id/);
  });
});
