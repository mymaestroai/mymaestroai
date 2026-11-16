'use strict';
// One view-only screenshot of a computer through MeshCentral's remote-desktop (KVM) relay.
// The caller opens the websocket; this file speaks the viewer side of the protocol and
// NEVER sends keyboard, mouse, touch or clipboard messages. The only things it sends are:
// the text '2', the compression command, the unpause command and SETDISPLAY.

const jpegjs = require('jpeg-js');

const CMD = Object.freeze({
  TILE: 3,
  COPYRECT: 4,
  COMPRESSION: 5,
  SCREEN: 7,
  PAUSE: 8,
  DISPLAYS: 11,
  SETDISPLAY: 12,
  JUMBO: 27,
  DISPLAY_INFO: 82,
});
const ALL_DISPLAYS = 65535;
const LIMITS = Object.freeze({
  maxSide: 16384,
  maxPixels: 40000000,
  maxBytes: 128 * 1024 * 1024,
  maxTiles: 50000,
});

class KvmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KvmError';
    this.code = code;
  }
}

// ---------- small builders ----------
function buildCompression(quality) {
  return Buffer.from([0x00, CMD.COMPRESSION, 0x00, 0x0a, 1, quality & 255, 0x04, 0x00, 0x00, 100]);
}
function buildUnpause() {
  return Buffer.from([0x00, CMD.PAUSE, 0x00, 0x05, 0x00]);
}
function buildSetDisplay(id) {
  return Buffer.from([0x00, CMD.SETDISPLAY, 0x00, 0x06, (id >> 8) & 255, id & 255]);
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
  return Buffer.alloc(0);
}

// ---------- command framing ----------
// push(message) -> array of { cmd, size, data } where data is exactly `size` bytes.
class CommandReader {
  constructor() {
    this.chunks = null;
    this.have = 0;
    this.need = 0;
  }

  get pending() {
    return this.need > 0;
  }

  _finish(buf) {
    return { cmd: buf.readUInt16BE(0), size: buf.length, data: buf };
  }

  push(input) {
    const msg = toBuffer(input);
    if (this.need > 0) {
      this.chunks.push(msg);
      this.have += msg.length;
      if (this.have < this.need) return [];
      const all = Buffer.concat(this.chunks);
      const cmd = all.subarray(0, this.need);
      this.chunks = null;
      this.have = 0;
      this.need = 0;
      return [this._finish(cmd)];
    }
    if (msg.length < 4) return [];
    let data = msg;
    let need = msg.readUInt16BE(2);
    if (msg.readUInt16BE(0) === CMD.JUMBO && need === 8) {
      if (msg.length < 8) return [];
      need = (msg[5] << 16) | (msg[6] << 8) | msg[7];
      data = msg.subarray(8);
    }
    if (need < 4) return [];
    if (data.length >= need) return [this._finish(data.subarray(0, need))];
    this.chunks = [data];
    this.have = data.length;
    this.need = need;
    return [];
  }
}

// Convenience for tests and tools: one message or a list of messages -> commands.
function parseCommands(messages) {
  const reader = new CommandReader();
  const list = Array.isArray(messages) ? messages : [messages];
  const out = [];
  for (const m of list) out.push(...reader.push(m));
  return out;
}

// ---------- JPEG header ----------
// { width, height } read from the SOF marker without decoding, or null.
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    while (i < buf.length && buf[i] === 0xff) i++; // fill bytes
    if (i >= buf.length) return null;
    const marker = buf[i++];
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / scan before any frame header
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 8 || i + 7 > buf.length) return null;
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      if (!width || !height) return null;
      return { width, height };
    }
    i += len;
  }
  return null;
}

// ---------- picture ----------
// Area-average (box) scale of an RGBA buffer.
function boxScale(src, w, h, ow, oh) {
  const out = Buffer.alloc(ow * oh * 4);
  const acc = new Float32Array(w * 4);
  const xs = w / ow;
  const ys = h / oh;
  const norm = xs * ys;
  for (let oy = 0; oy < oh; oy++) {
    const y0 = oy * ys;
    const y1 = Math.min(h, (oy + 1) * ys);
    acc.fill(0);
    for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy < h; sy++) {
      const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
      if (wy <= 0) continue;
      const row = sy * w * 4;
      for (let k = 0; k < w * 4; k++) acc[k] += src[row + k] * wy;
    }
    for (let ox = 0; ox < ow; ox++) {
      const x0 = ox * xs;
      const x1 = Math.min(w, (ox + 1) * xs);
      let r = 0, g = 0, b = 0, a = 0;
      for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx < w; sx++) {
        const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
        if (wx <= 0) continue;
        const p = sx * 4;
        r += acc[p] * wx;
        g += acc[p + 1] * wx;
        b += acc[p + 2] * wx;
        a += acc[p + 3] * wx;
      }
      const o = (oy * ow + ox) * 4;
      out[o] = Math.round(r / norm);
      out[o + 1] = Math.round(g / norm);
      out[o + 2] = Math.round(b / norm);
      out[o + 3] = Math.round(a / norm);
    }
  }
  return out;
}

// tiles: [{x, y, jpeg}] in arrival order. Returns { width, height, jpeg }.
function composeFrame(width, height, tiles, { maxWidth, quality, decode, encode }) {
  const canvas = Buffer.alloc(width * height * 4);
  for (const t of tiles) {
    let img;
    try {
      img = decode(t.jpeg, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, maxResolutionInMP: 64 });
    } catch (e) {
      throw new KvmError('EKVMTILE', 'A piece of the screen could not be decoded.');
    }
    const cw = Math.min(img.width, width - t.x);
    const ch = Math.min(img.height, height - t.y);
    for (let row = 0; row < ch; row++) {
      const from = row * img.width * 4;
      const to = ((t.y + row) * width + t.x) * 4;
      Buffer.from(img.data.buffer, img.data.byteOffset + from, cw * 4).copy(canvas, to);
    }
  }
  const outWidth = Math.min(width, maxWidth);
  const outHeight = Math.max(1, Math.round((height * outWidth) / width));
  const pixels = outWidth === width && outHeight === height ? canvas : boxScale(canvas, width, height, outWidth, outHeight);
  let enc;
  try {
    enc = encode({ data: pixels, width: outWidth, height: outHeight }, quality);
  } catch (e) {
    throw new KvmError('EKVMENCODE', 'The screenshot could not be encoded.');
  }
  return { width: outWidth, height: outHeight, jpeg: Buffer.from(enc.data) };
}

// ---------- capture ----------
function captureDesktop(ws, options) {
  const o = options || {};
  const maxWidth = o.maxWidth === undefined ? 1600 : o.maxWidth;
  const quality = o.quality === undefined ? 70 : o.quality;
  const timeoutMs = o.timeoutMs === undefined ? 25000 : o.timeoutMs;
  const infoGraceMs = o.infoGraceMs === undefined ? 700 : o.infoGraceMs;
  const decode = o.decode || jpegjs.decode;
  const encode = o.encode || jpegjs.encode;
  const setT = o.setTimeout || global.setTimeout;
  const clearT = o.clearTimeout || global.clearTimeout;

  if (!Number.isInteger(maxWidth) || maxWidth < 320 || maxWidth > 1920) {
    return Promise.reject(new KvmError('EBADARG', 'maxWidth must be a whole number from 320 to 1920.'));
  }
  if (!Number.isInteger(quality) || quality < 10 || quality > 100) {
    return Promise.reject(new KvmError('EBADARG', 'quality must be a whole number from 10 to 100.'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let handshake = false;
    const reader = new CommandReader();
    let totalBytes = 0;
    let tileCount = 0;

    // frame
    let screen = null; // { w, h }
    let tiles = [];
    let cov = null;
    let covered = 0;
    let discard = false; // after SETDISPLAY: ignore the old display until the next 7

    // displays
    let ids = null; // from 11
    let selected; // from 11 (or the one we switched to)
    let primary; // from 82
    let entryCount = 0;
    let switchSent = false;

    let graceTimer = null;
    let graceExpired = false;
    let overallTimer = null;

    const onMessage = (data, isBinary) => guard(() => handleMessage(data, isBinary));
    const onClose = () => fail(new KvmError('EKVMCLOSED', 'The remote screen connection closed before a picture arrived.'));
    const onError = () => fail(new KvmError('EKVMCLOSED', 'The remote screen connection failed before a picture arrived.'));
    const noop = () => {};

    function cleanup() {
      const off = typeof ws.removeListener === 'function' ? 'removeListener' : 'off';
      try {
        ws[off]('message', onMessage);
        ws[off]('close', onClose);
        ws[off]('error', onError);
        // A later socket error (for example while closing) must not crash the process.
        ws.on('error', noop);
      } catch (e) { /* ignore */ }
      if (overallTimer) clearT(overallTimer);
      if (graceTimer) clearT(graceTimer);
      overallTimer = null;
      graceTimer = null;
      try { ws.close(); } catch (e) { /* ignore */ }
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function succeed(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }
    function guard(fn) {
      if (settled) return;
      try {
        fn();
      } catch (e) {
        fail(e instanceof KvmError ? e : new KvmError('EKVMFAIL', 'The screen capture failed: ' + ((e && e.message) || 'unknown error')));
      }
    }
    function send(data) {
      try {
        ws.send(data);
      } catch (e) {
        throw new KvmError('EKVMCLOSED', 'Could not send to the remote screen connection.');
      }
    }

    function resetFrame(w, h) {
      screen = w ? { w, h } : null;
      tiles = [];
      cov = w ? new Uint8Array(w * h) : null;
      covered = 0;
    }
    function realCount() {
      return ids ? ids.filter((i) => i !== ALL_DISPLAYS).length : entryCount;
    }
    function startGrace() {
      if (graceTimer || graceExpired) return;
      graceTimer = setT(() => {
        graceTimer = null;
        graceExpired = true;
        guard(evaluate);
      }, infoGraceMs);
    }

    // Send SETDISPLAY(primary) once when the selected display is not the primary.
    function checkSwitch() {
      if (switchSent || primary === undefined || selected === undefined || selected === primary) return false;
      if (realCount() <= 1) return false;   // one display (or a list that names none): nothing to switch, and a switch might never be answered
      switchSent = true;
      send(buildSetDisplay(primary));
      selected = primary;
      discard = true;
      resetFrame(0, 0);
      return true;
    }

    function evaluate() {
      if (settled || !screen || discard || covered < screen.w * screen.h) return;
      if (checkSwitch()) return;
      const multi = realCount() > 1;
      let ready;
      if (selected === undefined) ready = graceExpired;
      else if (!multi || primary !== undefined) ready = true;
      else if (graceExpired) {
        if (selected === ALL_DISPLAYS) {
          throw new KvmError('EKVMPRIMARY', 'Could not tell which display is the main one on this computer.');
        }
        ready = true;
      } else ready = false;
      if (!ready) {
        startGrace();
        return;
      }
      const picture = composeFrame(screen.w, screen.h, tiles, { maxWidth, quality, decode, encode });
      succeed({
        width: picture.width,
        height: picture.height,
        screenWidth: screen.w,
        screenHeight: screen.h,
        jpeg: picture.jpeg,
        primaryKnown: primary !== undefined || !multi,
        display: selected === undefined ? null : selected,
        tiles: tiles.length,
      });
    }

    function handleScreen(c) {
      if (c.data.length < 8) return;
      const w = c.data.readUInt16BE(4);
      const h = c.data.readUInt16BE(6);
      if (w < 1 || h < 1 || w > LIMITS.maxSide || h > LIMITS.maxSide || w * h > LIMITS.maxPixels) {
        throw new KvmError('EKVMSIZE', 'The remote screen size is not usable (' + w + 'x' + h + ').');
      }
      discard = false;
      if (graceTimer) clearT(graceTimer);
      graceTimer = null;
      graceExpired = false;
      resetFrame(w, h);
      send(buildCompression(quality));
      send(buildUnpause());
      checkSwitch();
    }

    function handleTile(c) {
      tileCount++;
      if (tileCount > LIMITS.maxTiles) throw new KvmError('EKVMBIG', 'The remote screen sent too many pieces.');
      if (!screen || discard) return;
      if (c.data.length < 9) throw new KvmError('EKVMTILE', 'A piece of the screen was empty.');
      const x = c.data.readUInt16BE(4);
      const y = c.data.readUInt16BE(6);
      const jpeg = c.data.subarray(8);
      const size = jpegSize(jpeg);
      if (!size) throw new KvmError('EKVMTILE', 'A piece of the screen was not a readable picture.');
      if (x + size.width > screen.w || y + size.height > screen.h) {
        throw new KvmError('EKVMTILE', 'A piece of the screen was outside the screen.');
      }
      tiles.push({ x, y, jpeg: Buffer.from(jpeg) });
      for (let row = y; row < y + size.height; row++) {
        const base = row * screen.w;
        for (let col = x; col < x + size.width; col++) {
          if (!cov[base + col]) {
            cov[base + col] = 1;
            covered++;
          }
        }
      }
    }

    function handleDisplays(c) {
      const d = c.data;
      if (d.length < 6) return;
      const count = d.readUInt16BE(4);
      const list = [];
      let p = 6;
      for (let n = 0; n < count && p + 2 <= d.length; n++, p += 2) list.push(d.readUInt16BE(p));
      ids = list;
      if (p + 2 <= d.length && !discard) selected = d.readUInt16BE(p);
    }

    function handleDisplayInfo(c) {
      const d = c.data;
      if ((d.length - 4) % 10 !== 0) return;
      const n = (d.length - 4) / 10;
      entryCount = n;
      for (let k = 0; k < n; k++) {
        const p = 4 + k * 10;
        if (d.readInt16BE(p + 2) === 0 && d.readInt16BE(p + 4) === 0) {
          primary = d.readUInt16BE(p);
          break;
        }
      }
    }

    function handleCommand(c) {
      switch (c.cmd) {
        case CMD.SCREEN:
          handleScreen(c);
          break;
        case CMD.TILE:
          handleTile(c);
          evaluate();
          break;
        case CMD.COPYRECT:
          if (screen && !discard && covered < screen.w * screen.h) {
            throw new KvmError('EKVMCOPY', 'The remote screen sent a copy command before the picture was complete.');
          }
          break;
        case CMD.DISPLAYS:
          handleDisplays(c);
          checkSwitch();
          evaluate();
          break;
        case CMD.DISPLAY_INFO:
          handleDisplayInfo(c);
          checkSwitch();
          evaluate();
          break;
        default:
          break;
      }
      if (c.cmd === CMD.SCREEN) evaluate();
    }

    function handleMessage(data, isBinary) {
      const isText = typeof data === 'string' || isBinary === false;
      if (isText) {
        if (handshake) return;
        const text = (typeof data === 'string' ? data : toBuffer(data).toString('utf8')).trim();
        if (text === 'c' || text === 'cr') {
          handshake = true;
          send('2');
        }
        return;
      }
      if (!handshake) return;
      const buf = toBuffer(data);
      totalBytes += buf.length;
      if (totalBytes > LIMITS.maxBytes) throw new KvmError('EKVMBIG', 'The remote screen sent too much data.');
      for (const c of reader.push(buf)) {
        handleCommand(c);
        if (settled) return;
      }
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
    overallTimer = setT(() => {
      overallTimer = null;
      fail(new KvmError('EKVMTIMEOUT', 'The remote screen did not arrive in time.'));
    }, timeoutMs);
  });
}

module.exports = {
  captureDesktop,
  KvmError,
  CMD,
  ALL_DISPLAYS,
  LIMITS,
  CommandReader,
  parseCommands,
  jpegSize,
  boxScale,
  composeFrame,
  buildCompression,
  buildUnpause,
  buildSetDisplay,
};
