'use strict';
// image-gen.js — the generate_image tool: a picture (photo, illustration, edit of a reference image) made by
// an image model the owner holds a key for, saved into the agent's own Files folder and handed back as a
// markdown image line the chat renders inline. Claude models have no image output, so the picture always
// comes from Google (Gemini image models) or OpenAI (GPT image models); the agent still chooses what to ask.
//
// Models are the owner's choice (settings.imageModels), with current defaults below. "fast" is the cheap,
// quick tier; "best" the quality tier. The hub never prints keys and never writes outside the agent's root.

const fs = require('fs');
const path = require('path');

const DEFAULT_MODELS = {
  google: { fast: 'gemini-3.1-flash-image', best: 'gemini-3-pro-image' },
  openai: { fast: 'gpt-image-1-mini', best: 'gpt-image-2' },
};
const PROVIDERS = Object.keys(DEFAULT_MODELS);
const SIZES = { square: { aspect: '1:1', openai: '1024x1024' }, landscape: { aspect: '16:9', openai: '1536x1024' }, portrait: { aspect: '9:16', openai: '1024x1536' } };
const MAX_PROMPT = 4000;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

class ImageGenError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function slug(s) { return String(s || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image'; }
function stamp(now) { const d = new Date(now()); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function isUnder(p, root) { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }

/**
 * createImageGen({ fetchImpl, getProviderKey, getSetting, now }) -> { generate, models, providers }
 *   generate({ agentName, root, extraRoots, prompt, provider, quality, size, reference, filename, log })
 *     root: the agent's Files folder (where the picture is saved under images/); extraRoots: other folders a
 *     reference image may be read from (the agent's workspace). Returns { path, markdown, provider, model, bytes, ms, note }.
 */
function createImageGen({ fetchImpl = (...a) => fetch(...a), getProviderKey, getSetting = () => undefined, now = () => Date.now() } = {}) {
  function models() {
    const o = getSetting('imageModels') || {};
    const out = {};
    for (const p of PROVIDERS) out[p] = { ...DEFAULT_MODELS[p], ...((o && o[p]) || {}) };
    return out;
  }
  function pick({ provider, quality }) {
    const p = String(provider || getSetting('imageProvider') || 'google').toLowerCase();
    if (!PROVIDERS.includes(p)) throw new ImageGenError(`provider must be one of ${PROVIDERS.join(', ')}`);
    const q = String(quality || 'fast').toLowerCase();
    if (!['fast', 'best'].includes(q)) throw new ImageGenError('quality must be "fast" or "best"');
    const key = getProviderKey(p === 'google' ? 'google' : 'openai');
    if (!key) throw new ImageGenError(`No ${p === 'google' ? 'Google (Gemini)' : 'OpenAI'} API key is set on this hub, so no picture can be made with ${p}. The owner adds keys in Settings.`, 503);
    return { provider: p, quality: q, model: models()[p][q], key };
  }
  function readReference(reference, roots) {
    if (!reference) return null;
    const abs = path.resolve(String(reference));
    if (!roots.some(r => isUnder(abs, r))) throw new ImageGenError('The reference image must be in your own Files folder or workspace.');
    let st; try { st = fs.statSync(abs); } catch { throw new ImageGenError(`Reference image not found: ${abs}`); }
    if (!st.isFile() || st.size > MAX_REFERENCE_BYTES) throw new ImageGenError('Reference image must be a file under 20 MB.');
    const mime = MIME[path.extname(abs).toLowerCase()];
    if (!mime) throw new ImageGenError('Reference image must be png, jpg, webp or gif.');
    return { abs, mime, data: fs.readFileSync(abs) };
  }

  async function google({ model, key, prompt, size, ref }) {
    const parts = [];
    if (ref) parts.push({ inlineData: { mimeType: ref.mime, data: ref.data.toString('base64') } });
    parts.push({ text: prompt });
    const body = { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: SIZES[size].aspect } } };
    const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ImageGenError(`Google image model ${model} refused (${r.status}): ${String(j.error && j.error.message || JSON.stringify(j)).slice(0, 300)}`, 502);
    const cparts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const img = cparts.find(p => p.inlineData && /^image\//.test(p.inlineData.mimeType || ''));
    const text = cparts.filter(p => typeof p.text === 'string').map(p => p.text).join(' ').trim();
    if (!img) throw new ImageGenError(`Google image model ${model} returned no image${text ? `: ${text.slice(0, 300)}` : ''}${j.promptFeedback ? ` (${JSON.stringify(j.promptFeedback).slice(0, 200)})` : ''}`, 502);
    return { buffer: Buffer.from(img.inlineData.data, 'base64'), mime: img.inlineData.mimeType, note: text || null };
  }

  async function openai({ model, key, prompt, size, ref }) {
    let r;
    if (ref) {
      const form = new FormData();
      form.append('model', model); form.append('prompt', prompt); form.append('size', SIZES[size].openai); form.append('n', '1');
      form.append('image[]', new Blob([ref.data], { type: ref.mime }), path.basename(ref.abs));
      r = await fetchImpl('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(180000) });
    } else {
      r = await fetchImpl('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, prompt, size: SIZES[size].openai, n: 1 }), signal: AbortSignal.timeout(180000) });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ImageGenError(`OpenAI image model ${model} refused (${r.status}): ${String(j.error && j.error.message || JSON.stringify(j)).slice(0, 300)}`, 502);
    const d = (j.data || [])[0];
    if (!d || !d.b64_json) throw new ImageGenError(`OpenAI image model ${model} returned no image.`, 502);
    return { buffer: Buffer.from(d.b64_json, 'base64'), mime: 'image/png', note: d.revised_prompt || null };
  }

  async function generate({ agentName, root, extraRoots = [], prompt, provider, quality, size = 'square', reference = null, filename = null, log = () => {} } = {}) {
    const p = String(prompt || '').trim();
    if (!p) throw new ImageGenError('prompt is required');
    if (p.length > MAX_PROMPT) throw new ImageGenError(`prompt is too long (max ${MAX_PROMPT} characters)`);
    const sz = String(size || 'square').toLowerCase();
    if (!SIZES[sz]) throw new ImageGenError(`size must be one of ${Object.keys(SIZES).join(', ')}`);
    if (!root) throw new ImageGenError('No Files folder for this agent.');
    const chosen = pick({ provider, quality });
    const ref = readReference(reference, [root, ...extraRoots].filter(r => typeof r === 'string' && r).map(r => path.resolve(r)));
    const t0 = now();
    const out = chosen.provider === 'google' ? await google({ ...chosen, prompt: p, size: sz, ref }) : await openai({ ...chosen, prompt: p, size: sz, ref });
    const ms = now() - t0;
    const ext = out.mime === 'image/jpeg' ? '.jpg' : out.mime === 'image/webp' ? '.webp' : '.png';
    const dir = path.join(path.resolve(root), 'images');
    fs.mkdirSync(dir, { recursive: true });
    const base = filename ? slug(String(filename).replace(/\.[a-z0-9]+$/i, '')) : `${stamp(now)}-${slug(p)}`;
    let file = path.join(dir, base + ext); let n = 2;
    while (fs.existsSync(file)) file = path.join(dir, `${base}-${n++}${ext}`);
    fs.writeFileSync(file, out.buffer);
    log(`[image] ${agentName}: ${chosen.provider}/${chosen.model} ${ref ? 'edit' : 'generate'} ${out.buffer.length} bytes in ${ms} ms -> ${file}`);
    const alt = p.replace(/[\[\]\n]/g, ' ').slice(0, 120);
    return { path: file, markdown: `![${alt}](${file})`, provider: chosen.provider, model: chosen.model, bytes: out.buffer.length, ms, note: out.note, edited: !!ref };
  }

  return { generate, models, providers: PROVIDERS.slice(), sizes: Object.keys(SIZES) };
}

/** The reply the agent gets: the markdown line to paste, plus where the file is. */
function describe(r) {
  return `Image made with ${r.provider} (${r.model}) in ${(r.ms / 1000).toFixed(1)} s, ${Math.round(r.bytes / 1024)} KB, saved to your Files folder at ${r.path}.\nTo show it in your reply, put this line in your answer on its own line:\n${r.markdown}${r.note ? `\n(model note: ${String(r.note).slice(0, 300)})` : ''}`;
}

let shared = null;
function getImageGen(opts) { if (!shared) shared = createImageGen(opts); return shared; }

module.exports = { createImageGen, getImageGen, describe, ImageGenError, DEFAULT_MODELS, SIZES };
