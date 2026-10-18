'use strict';
// Images attached to a consult_agent / spawn_workers call. Each entry is an absolute path to an image
// file on this machine, or a data URL (saved to data/uploads first). Everything is validated here, once,
// and handed on as file paths: the consulted agent's turn receives them as imagePaths, exactly like an
// image the owner pastes into the chat (SDK content blocks, gateway image_url parts, Codex -i / localImage).

const fs = require('fs');
const path = require('path');

const MAX_IMAGES = 8;
const MAX_BYTES = 10 * 1024 * 1024;
const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,/i;

const IMAGES_DESCRIPTION = `Optional images to show the agent: up to ${MAX_IMAGES}, each an absolute file path on this machine (jpg, png, webp or gif, max 10 MB) or a data URL. The agent receives them as real images alongside your prompt.`;

function looksLikeImage(buf) {
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;          // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;                             // JPEG
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return true;                                       // GIF
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return true;   // WEBP
  return false;
}

/**
 * @param {*} images                     the tool argument
 * @param {{ save?: (dataUrl:string)=>string|null, allowData?: boolean, label?: string }} [o]
 * @returns {{ paths: string[] } | { error: string }}
 */
function resolveImages(images, { save = null, allowData = true, label = 'images' } = {}) {
  if (images === undefined || images === null) return { paths: [] };
  if (!Array.isArray(images)) return { error: `${label} must be an array of strings (absolute file paths or data URLs)` };
  if (images.length > MAX_IMAGES) return { error: `too many images: ${images.length} given, at most ${MAX_IMAGES} per call` };
  const paths = [];
  for (let i = 0; i < images.length; i++) {
    const v = images[i];
    const at = `${label}[${i}]`;
    if (typeof v !== 'string' || !v.trim()) return { error: `${at}: must be a non-empty string` };
    if (v.startsWith('data:')) {
      if (!allowData) return { error: `${at}: data URLs are not accepted here, pass a file path` };
      if (!DATA_URL.test(v)) return { error: `${at}: data URL must be base64 image/png, image/jpeg, image/webp or image/gif` };
      const b64 = v.slice(v.indexOf(',') + 1);
      const bytes = Math.floor(b64.length * 3 / 4);
      if (bytes > MAX_BYTES) return { error: `${at}: data URL is about ${(bytes / 1048576).toFixed(1)} MB, the limit is 10 MB` };
      if (!looksLikeImage(Buffer.from(b64.slice(0, 64), 'base64'))) return { error: `${at}: data URL does not contain an image` };
      const p = save ? save(v) : null;
      if (!p) return { error: `${at}: could not save the data URL` };
      paths.push(p);
      continue;
    }
    if (!path.isAbsolute(v)) return { error: `${at}: "${v.slice(0, 80)}" is not an absolute path` };
    const p = path.resolve(v);
    if (!EXTS.has(path.extname(p).toLowerCase())) return { error: `${at}: ${p} is not a jpg, png, webp or gif file` };
    let st;
    try { st = fs.statSync(p); } catch { return { error: `${at}: file not found: ${p}` }; }
    if (!st.isFile()) return { error: `${at}: not a file: ${p}` };
    if (st.size > MAX_BYTES) return { error: `${at}: ${p} is ${(st.size / 1048576).toFixed(1)} MB, the limit is 10 MB` };
    let head;
    try { const fd = fs.openSync(p, 'r'); try { head = Buffer.alloc(12); fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); } }
    catch (e) { return { error: `${at}: cannot read ${p}: ${e.message}` }; }
    if (!looksLikeImage(head)) return { error: `${at}: ${p} does not contain image data` };
    paths.push(p);
  }
  return { paths };
}

/** Line appended to the prompt: tells the consulted agent (and its log) what was attached, and where the files are. */
function imageNote(paths, from) {
  if (!paths || !paths.length) return '';
  return `\n\n[${paths.length} image${paths.length === 1 ? '' : 's'} attached${from ? ` by "${from}"` : ''}: ${paths.join(', ')}. They are delivered with this message as images; if you cannot see them, open the files at those paths.]`;
}

module.exports = { resolveImages, imageNote, MAX_IMAGES, MAX_BYTES, IMAGES_DESCRIPTION };
