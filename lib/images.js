'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const IMAGE_OUTPUT_DIRS = [
  path.join(__dirname, '..', 'data', 'image-gen', 'out'),
];
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// serveImage only serves files whose real path is inside one of these roots (anything else is a 404, same as a missing file).
// The hub home is the folder that holds the install (share/, users/, medical/, legal/), as in lib/tool-policy.js and
// lib/files.js. It used to be fixed at ~/agent-hub, so on any other layout every Files-folder image was a 404.
const { HUB_HOME } = require('./hub-home');   // share/, users/, medical/, legal/: see lib/hub-home
const SERVE_ROOTS = [
  UPLOAD_DIR,
  ...IMAGE_OUTPUT_DIRS,
  '/tmp',
  os.tmpdir(),
  path.join(HUB_HOME, 'share'),
  path.join(HUB_HOME, 'users'),
  path.join(HUB_HOME, 'medical'),
  path.join(HUB_HOME, 'legal'),
  path.join(__dirname, '..', 'workspaces'),
];

// Track processed uploads
const _processedUploads = new Set();

// Ensure upload and image-gen dirs exist
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(path.join(__dirname, '..', 'data', 'image-gen', 'out'), { recursive: true }); } catch {}

// MIME types for images
const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Save a data URL (image/png, image/jpeg, image/gif or image/webp, base64, at most 20 MB) to file.
 * Returns the path, or null after logging the reason (bad MIME, too big, invalid base64).
 */
function saveUploadedImage(base64Data) {
  try {
    if (typeof base64Data !== 'string' || !base64Data.startsWith('data:')) throw new Error('expected a data: URL');
    const comma = base64Data.indexOf(',');
    if (comma < 0) throw new Error('malformed data URL');
    const header = base64Data.slice(0, comma);
    const data = base64Data.slice(comma + 1);
    const mime = header.split(';')[0].split(':')[1];
    const ext = mimeToExt(mime);
    if (!ext) throw new Error(`unsupported image type "${mime}" (png, jpeg, gif, webp only)`);
    if (data.length * 3 / 4 > MAX_UPLOAD_BYTES) throw new Error(`image exceeds ${MAX_UPLOAD_BYTES} bytes`);

    const imageData = Buffer.from(data, 'base64');
    if (imageData.length === 0) throw new Error('invalid base64 payload');
    if (imageData.length > MAX_UPLOAD_BYTES) throw new Error(`image exceeds ${MAX_UPLOAD_BYTES} bytes`);
    const filename = crypto.randomUUID().replace(/-/g, '') + ext;
    const filepath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filepath, imageData);
    console.log(`IMAGE SAVED: ${filepath} (${imageData.length} bytes)`);
    return filepath;
  } catch (e) {
    console.error(`IMAGE SAVE FAILED: ${e.message}`);
    return null;
  }
}

/**
 * Convert MIME type to file extension
 */
function mimeToExt(mime) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return map[mime] || null;
}

/** Real path of p if it is a regular file under one of SERVE_ROOTS, else null (missing, directory, outside). */
function resolveServablePath(p) {
  let real;
  try {
    real = fs.realpathSync(path.resolve(p));
    if (!fs.statSync(real).isFile()) return null;
  } catch { return null; }
  for (const root of SERVE_ROOTS) {
    let r;
    try { r = fs.realpathSync(root); } catch { continue; }       // root does not exist (yet): cannot contain anything
    if (real === r || real.startsWith(r + path.sep)) return real;
  }
  return null;
}

/**
 * Serve an image file to an HTTP response by encoded path
 */
function serveImage(encodedPath, res) {
  try {
    const imagePath = Buffer.from(encodedPath, 'base64').toString('utf8');

    // Resolve symlinks, then require a regular file with an image extension inside one of SERVE_ROOTS.
    // Every failure is the same 404 so the response never reveals whether a path outside the roots exists.
    const real = resolveServablePath(imagePath);
    const ext = real ? path.extname(real).toLowerCase() : '';
    const mime = MIME_MAP[ext];
    if (!real || !mime) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Image not found');
      return;
    }

    const content = fs.readFileSync(real);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': content.length,
      'Cache-Control': 'max-age=3600',
    });
    res.end(content);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error serving image: ${e.message}`);
  }
}

/**
 * Get images created after sinceTime (epoch seconds) in a directory
 */
function getRecentImages(directory, sinceTime) {
  const images = [];
  try {
    const dirPath = directory.replace(/^~/, process.env.HOME);
    if (!fs.existsSync(dirPath)) return images;

    for (const f of fs.readdirSync(dirPath)) {
      const ext = path.extname(f).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      const fullPath = path.join(dirPath, f);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs / 1000 > sinceTime) {
        images.push(fullPath);
      }
    }
  } catch {}
  return images.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

/**
 * Convert image paths to API URLs
 */
function imagePathsToUrls(imagePaths) {
  return imagePaths
    .filter(p => !p.startsWith(UPLOAD_DIR))
    .map(p => `/api/image/${Buffer.from(p).toString('base64')}`);
}

/**
 * Parse MEDIA: lines from response text. Returns { cleanedText, imagePaths }
 */
function parseMediaLines(text) {
  const images = [];
  const cleaned = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('MEDIA:')) {
      const p = line.slice(6).trim();
      if (fs.existsSync(p)) images.push(p);
    } else if (!line.startsWith('Saved:')) {
      cleaned.push(line);
    }
  }
  return { cleanedText: cleaned.join('\n'), imagePaths: images };
}

/**
 * Convert uploaded image files to Anthropic SDK base64 format
 */
function imagesToAnthropicFormat(imagePaths) {
  const blocks = [];
  for (const imgPath of imagePaths) {
    try {
      const data = fs.readFileSync(imgPath);
      const ext = path.extname(imgPath).toLowerCase();
      const mediaType = MIME_MAP[ext] || 'image/png';
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: data.toString('base64'),
        },
      });
    } catch (e) {
      console.error(`Failed to read image ${imgPath}: ${e.message}`);
    }
  }
  return blocks;
}

function markProcessed(filepath) { _processedUploads.add(filepath); }
function isProcessed(filepath) { return _processedUploads.has(filepath); }

module.exports = {
  UPLOAD_DIR,
  HUB_HOME,
  SERVE_ROOTS,
  IMAGE_OUTPUT_DIRS,
  saveUploadedImage,
  serveImage,
  getRecentImages,
  imagePathsToUrls,
  parseMediaLines,
  imagesToAnthropicFormat,
  markProcessed,
  isProcessed,
};
