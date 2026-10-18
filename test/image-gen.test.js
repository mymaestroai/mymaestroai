'use strict';
// generate_image: Google and OpenAI paths with fake HTTP, saving into the agent's Files folder, reference edits
// limited to the agent's own folders, model choice from settings, refusals and error text.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createImageGen, describe, DEFAULT_MODELS, SIZES } = require('../lib/image-gen');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f6d0000000049454e44ae426082', 'hex');
function rig({ keys = { google: 'g', openai: 'o' }, settings = {}, google = null, openai = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('generativelanguage')) {
      if (google && google.error) return { ok: false, status: 400, json: async () => ({ error: { message: google.error } }) };
      if (google && google.noImage) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'I cannot draw that' }] } }] }) };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] }) };
    }
    if (url.includes('api.openai.com')) {
      if (openai && openai.error) return { ok: false, status: 429, json: async () => ({ error: { message: openai.error } }) };
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a cat, revised' }] }) };
    }
    throw new Error('unexpected url ' + url);
  };
  let t = 1_760_000_000_000;
  const gen = createImageGen({ fetchImpl, getProviderKey: (p) => keys[p] || null, getSetting: (k) => settings[k], now: () => (t += 1500) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgroot-')); const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'imgws-'));
  return { gen, calls, root, ws };
}

test('google by default: request shape, aspect, file saved under <root>/images, markdown line, describe()', async () => {
  const r = rig();
  const out = await r.gen.generate({ agentName: 'gp', root: r.root, prompt: 'A watercolor of a lighthouse at dusk', size: 'landscape' });
  assert.strictEqual(out.provider, 'google'); assert.strictEqual(out.model, DEFAULT_MODELS.google.fast); assert.strictEqual(out.edited, false);
  assert.ok(out.path.startsWith(path.join(r.root, 'images') + path.sep) && out.path.endsWith('.png'));
  assert.ok(fs.existsSync(out.path) && fs.readFileSync(out.path).equals(PNG));
  assert.match(out.markdown, /^!\[A watercolor of a lighthouse at dusk\]\(.*\.png\)$/);
  assert.strictEqual(out.note, 'here you go');
  const call = r.calls[0]; assert.match(call.url, /models\/gemini-3\.1-flash-image:generateContent$/);
  assert.strictEqual(call.init.headers['x-goog-api-key'], 'g');
  const body = JSON.parse(call.init.body);
  assert.deepStrictEqual(body.generationConfig, { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: SIZES.landscape.aspect } });
  assert.deepStrictEqual(body.contents[0].parts, [{ text: 'A watercolor of a lighthouse at dusk' }]);
  const d = describe(out); assert.match(d, /Image made with google/); assert.ok(d.includes(out.markdown)); assert.match(d, /model note: here you go/);
  const again = await r.gen.generate({ agentName: 'gp', root: r.root, prompt: 'A watercolor of a lighthouse at dusk', size: 'landscape' });
  assert.notStrictEqual(again.path, out.path, 'no overwrite: a second file');
});

test('openai: generation and edit (multipart with the reference), best tier from settings override, revised prompt as note', async () => {
  const r = rig({ settings: { imageModels: { openai: { best: 'gpt-image-9-test' } } } });
  const out = await r.gen.generate({ agentName: 'a', root: r.root, prompt: 'a cat', provider: 'openai', quality: 'best', size: 'portrait', filename: 'My Cat.png' });
  assert.deepStrictEqual([out.provider, out.model, path.basename(out.path), out.note], ['openai', 'gpt-image-9-test', 'my-cat.png', 'a cat, revised']);
  const gen = r.calls[0]; assert.match(gen.url, /images\/generations$/); assert.strictEqual(gen.init.headers.authorization, 'Bearer o');
  assert.deepStrictEqual(JSON.parse(gen.init.body), { model: 'gpt-image-9-test', prompt: 'a cat', size: '1024x1536', n: 1 });
  // edit with a reference inside the workspace
  const ref = path.join(r.ws, 'base.png'); fs.writeFileSync(ref, PNG);
  const ed = await r.gen.generate({ agentName: 'a', root: r.root, extraRoots: [r.ws], prompt: 'make it night', provider: 'openai', reference: ref });
  assert.strictEqual(ed.edited, true);
  const edit = r.calls[1]; assert.match(edit.url, /images\/edits$/); assert.ok(edit.init.body instanceof FormData);
  assert.strictEqual(edit.init.body.get('model'), DEFAULT_MODELS.openai.fast); assert.strictEqual(edit.init.body.get('prompt'), 'make it night');
  assert.ok(edit.init.body.get('image[]') instanceof Blob);
  // google edit: the reference goes in as inlineData before the text
  const g = await r.gen.generate({ agentName: 'a', root: r.root, extraRoots: [r.ws], prompt: 'make it day', reference: ref });
  const gb = JSON.parse(r.calls[2].init.body);
  assert.strictEqual(gb.contents[0].parts[0].inlineData.mimeType, 'image/png'); assert.strictEqual(gb.contents[0].parts[1].text, 'make it day'); assert.strictEqual(g.edited, true);
});

test('refusals: missing key, bad provider/size/quality, empty or huge prompt, reference outside the agent\'s folders, missing or wrong-type reference, API errors', async () => {
  const r = rig({ keys: { google: null, openai: 'o' } });
  await assert.rejects(r.gen.generate({ agentName: 'a', root: r.root, prompt: 'x' }), /No Google \(Gemini\) API key/);
  await assert.rejects(r.gen.generate({ agentName: 'a', root: r.root, prompt: 'x', provider: 'midjourney' }), /provider must be one of/);
  await assert.rejects(r.gen.generate({ agentName: 'a', root: r.root, prompt: 'x', provider: 'openai', size: 'huge' }), /size must be/);
  await assert.rejects(r.gen.generate({ agentName: 'a', root: r.root, prompt: 'x', provider: 'openai', quality: 'ultra' }), /quality must be/);
  await assert.rejects(r.gen.generate({ agentName: 'a', root: r.root, prompt: '   ', provider: 'openai' }), /prompt is required/);
  await assert.rejects(r.gen.generate({ agentName: 'a', root: r.root, prompt: 'x'.repeat(5000), provider: 'openai' }), /too long/);
  await assert.rejects(r.gen.generate({ agentName: 'a', root: r.root, prompt: 'x', provider: 'openai', reference: '/etc/passwd' }), /must be in your own Files folder or workspace/);
  await assert.rejects(r.gen.generate({ agentName: 'a', root: r.root, prompt: 'x', provider: 'openai', reference: path.join(r.root, 'missing.png') }), /not found/);
  fs.writeFileSync(path.join(r.root, 'notes.txt'), 'hi');
  await assert.rejects(r.gen.generate({ agentName: 'a', root: r.root, prompt: 'x', provider: 'openai', reference: path.join(r.root, 'notes.txt') }), /png, jpg, webp or gif/);
  await assert.rejects(r.gen.generate({ agentName: 'a', root: null, prompt: 'x', provider: 'openai' }), /No Files folder/);
  assert.strictEqual(r.calls.length, 0, 'nothing was sent for any refusal');
  const e1 = rig({ google: { error: 'Safety block' } });
  await assert.rejects(e1.gen.generate({ agentName: 'a', root: e1.root, prompt: 'x' }), /Google image model .* refused \(400\): Safety block/);
  const e2 = rig({ google: { noImage: true } });
  await assert.rejects(e2.gen.generate({ agentName: 'a', root: e2.root, prompt: 'x' }), /returned no image: I cannot draw that/);
  const e3 = rig({ openai: { error: 'rate limited' } });
  await assert.rejects(e3.gen.generate({ agentName: 'a', root: e3.root, prompt: 'x', provider: 'openai' }), /OpenAI image model .* refused \(429\): rate limited/);
  assert.strictEqual(fs.readdirSync(e3.root).filter(f => f === 'images').length, 0, 'no images folder created on failure');
});

test('models(): settings override merges over the defaults per provider; provider default from settings', async () => {
  const r = rig({ settings: { imageModels: { google: { fast: 'g-fast-x' } }, imageProvider: 'openai' } });
  assert.deepStrictEqual(r.gen.models().google, { fast: 'g-fast-x', best: DEFAULT_MODELS.google.best });
  assert.deepStrictEqual(r.gen.models().openai, DEFAULT_MODELS.openai);
  const out = await r.gen.generate({ agentName: 'a', root: r.root, prompt: 'x' });
  assert.strictEqual(out.provider, 'openai', 'settings.imageProvider picks the default vendor');
});

test('extraRoots that are not strings (a forgotten await) are ignored instead of crashing the call', async () => {
  const r = rig();
  const out = await r.gen.generate({ agentName: 'a', root: r.root, extraRoots: [Promise.resolve('/x'), null, undefined], prompt: 'ok' });
  assert.ok(out.path.endsWith('.png'));
});
