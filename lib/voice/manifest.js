'use strict';

// lib/voice/manifest.js: everything the voice feature downloads, pinned (version, URL, size, sha256), plus the
// voice list and the sanitisers for the `voice` setting and the per-agent `voice` field.
//
// Pinning notes (decided with the engine evaluation, 2026-11-12):
//  - sherpa-onnx 1.13.8, not 2.x: 1.x still has the built-in espeak-ng, so every word is spoken (2.x drops words that
//    are missing from its lexicon). espeak-ng is GPL-3; it is inside the downloaded binary, fetched at enable time,
//    never part of this repository.
//  - The npm tarball sha256 values below were computed once by hand (sha256sum of the registry tarballs; the vad-web and
//    onnxruntime-web tarballs were also checked against the registry's dist.integrity sha512). The hub downloads at runtime
//    and refuses any file whose sha256 differs.
//  - Model archives come from the k2-fsa/sherpa-onnx GitHub releases (rolling tags): the sha256 is what pins them.

const NPM = 'https://registry.npmjs.org';
const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

// ONE BLOCK for the sherpa-onnx engine: its version and the size and sha256 of each npm package (the node binding and one
// package per platform). Switching versions (for example to 2.x) is an edit of this block and nothing else: the package
// table, the urls and the platform map below are all derived from it. `platform` is node's `${process.platform}-${process.arch}`.
const SHERPA = {
  version: '1.13.8',
  packages: {
    'sherpa-onnx-node': { bytes: 11954, sha256: 'db2a7b8b18d950b6e9ca5c1c919afec33fd3dd2bfef1aade0bea5a9fe7a1f0f1' },
    'sherpa-onnx-linux-x64': { platform: 'linux-x64', bytes: 11089653, sha256: '13291bcd825da5858ca27a35443e9a2c229a40616c0910086de2db12c5c9312c' },
    'sherpa-onnx-darwin-arm64': { platform: 'darwin-arm64', bytes: 10047754, sha256: 'e1abc1d9676478996574de922e55714d80b4500b860bc4e7349aa01cd0ea4929' },
    'sherpa-onnx-darwin-x64': { platform: 'darwin-x64', bytes: 11191481, sha256: '3e583d3423160cb8a0f9316008e293ad9a6b66c63e1966ad399a88300390fbaa' },
  },
};
const SHERPA_VERSION = SHERPA.version;

/** npm tarballs extracted (tar --strip-components=1) into <dir>/node_modules/<name>. */
const NODE_PACKAGES = Object.fromEntries(Object.entries(SHERPA.packages).map(([name, p]) => [name, {
  name, version: SHERPA.version, bytes: p.bytes,
  url: `${NPM}/${name}/-/${name}-${SHERPA.version}.tgz`,
  sha256: p.sha256,
}]));

/** The platform package for a node platform/arch, or null when the platform is not supported. */
const PLATFORM_PACKAGE = Object.fromEntries(Object.entries(SHERPA.packages).filter(([, p]) => p.platform).map(([name, p]) => [p.platform, name]));
function platformPackage(platform, arch) { return PLATFORM_PACKAGE[`${platform}-${arch}`] || null; }

/**
 * Models. Each archive has one top folder; `files` are the members (under that folder) that are kept, extracted to
 * <dir>/models/<id>/ (the folder level is stripped). Directories in `files` are extracted whole.
 */
const MODELS = {
  'whisper-tiny.en': {
    id: 'whisper-tiny.en', kind: 'stt', label: 'Whisper tiny.en (fast)', size: 'tiny.en',
    url: `${GH}/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2`, bytes: 118071777, format: 'tar',
    sha256: '2bd6cf965c8bb3e068ef9fa2191387ee63a9dfa2a4e37582a8109641c20005dd',
    top: 'sherpa-onnx-whisper-tiny.en',
    files: ['tiny.en-encoder.int8.onnx', 'tiny.en-decoder.int8.onnx', 'tiny.en-tokens.txt'],
    used: { encoder: 'tiny.en-encoder.int8.onnx', decoder: 'tiny.en-decoder.int8.onnx', tokens: 'tiny.en-tokens.txt' },
  },
  'whisper-small.en': {
    id: 'whisper-small.en', kind: 'stt', label: 'Whisper small.en (more accurate)', size: 'small.en',
    url: `${GH}/asr-models/sherpa-onnx-whisper-small.en.tar.bz2`, bytes: 635693775, format: 'tar',
    sha256: '0cdba2b8aaab69e04847f3427cc9709574112e67913a1a84b7fec3a8729faa9a',
    top: 'sherpa-onnx-whisper-small.en',
    files: ['small.en-encoder.int8.onnx', 'small.en-decoder.int8.onnx', 'small.en-tokens.txt'],
    used: { encoder: 'small.en-encoder.int8.onnx', decoder: 'small.en-decoder.int8.onnx', tokens: 'small.en-tokens.txt' },
  },
  'kokoro-multi-lang-v1_0': {
    id: 'kokoro-multi-lang-v1_0', kind: 'tts', label: 'Kokoro v1.0 (fp32)',
    url: `${GH}/tts-models/kokoro-multi-lang-v1_0.tar.bz2`, bytes: 349886476, format: 'tar',
    sha256: '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4',
    top: 'kokoro-multi-lang-v1_0',
    files: ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-gb-en.txt', 'espeak-ng-data', 'LICENSE'],
    used: { model: 'model.onnx', voices: 'voices.bin', tokens: 'tokens.txt', lexiconUs: 'lexicon-us-en.txt', lexiconGb: 'lexicon-gb-en.txt', dataDir: 'espeak-ng-data' },
  },
  'piper-en_GB-alba-medium': {
    id: 'piper-en_GB-alba-medium', kind: 'tts', label: 'Piper alba (Scottish, fp32)',
    url: `${GH}/tts-models/vits-piper-en_GB-alba-medium.tar.bz2`, bytes: 67212349, format: 'tar',
    sha256: 'fcd45962906933eec4431d3688f7d74aaac8713c87c6717f91fd3b23463aa1a1',
    top: 'vits-piper-en_GB-alba-medium',
    files: ['en_GB-alba-medium.onnx', 'tokens.txt', 'espeak-ng-data', 'MODEL_CARD'],
    used: { model: 'en_GB-alba-medium.onnx', tokens: 'tokens.txt', dataDir: 'espeak-ng-data' },
  },
  'piper-en_US-lessac-medium': {
    id: 'piper-en_US-lessac-medium', kind: 'tts', label: 'Piper lessac (US, fp32)',
    url: `${GH}/tts-models/vits-piper-en_US-lessac-medium.tar.bz2`, bytes: 67230653, format: 'tar',
    sha256: '9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e',
    top: 'vits-piper-en_US-lessac-medium',
    files: ['en_US-lessac-medium.onnx', 'tokens.txt', 'espeak-ng-data', 'MODEL_CARD'],
    used: { model: 'en_US-lessac-medium.onnx', tokens: 'tokens.txt', dataDir: 'espeak-ng-data' },
  },
  // Server-side speech detector (optional: phase 1 does not need it; the browser detector is the one used live).
  'silero-vad': {
    id: 'silero-vad', kind: 'vad', label: 'Silero VAD', optional: true,
    url: `${GH}/asr-models/silero_vad.onnx`, bytes: 643854, format: 'file', fileName: 'silero_vad.onnx',
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    files: ['silero_vad.onnx'], used: { model: 'silero_vad.onnx' },
  },
};

/** Browser speech detector (phase 2 uses it; phase 1 only downloads and serves it): two npm tarballs, six files. */
const WEB_PACKAGES = {
  'vad-web': {
    id: 'vad-web', version: '0.0.31', bytes: 5471324,
    url: `${NPM}/@ricky0123/vad-web/-/vad-web-0.0.31.tgz`,
    sha256: 'd1a211cf1a2ed26297da52cc08de79e75d79838a274bfc6de546feb1f828c940',
    integrity: 'sha512-ePVq8TvB21sdHSxVMZOEIf9JVa7MAYpaIaNXeGgsPOiMCN8xbPCdF2LS5aYj7VRR3ZxzutedgV9ZplV65IA1Fg==',
  },
  'onnxruntime-web': {
    id: 'onnxruntime-web', version: '1.22.0', bytes: 20387966,
    url: `${NPM}/onnxruntime-web/-/onnxruntime-web-1.22.0.tgz`,
    sha256: 'e293551f9d36d003e293d0f2937fee7b3dfdcef76d71d1449b55e2d4157c7aea',
    integrity: 'sha512-Ud/+EBo6mhuaQWt/OjaOk0iNWjXqJoeeMFr6xQEERZdIZH2OWpGzuujz7lfuOBjUa6TEE/sc4nb7Da5dNL34fg==',
  },
};

/** The files served to the browser: name -> { from: package id, member inside the tarball, sha256 of the file, type }. */
const WEB_FILES = {
  'bundle.min.js': { pkg: 'vad-web', member: 'package/dist/bundle.min.js', sha256: '4b3f72db78dc5f65c0ba9047a9033581e15fe57810a3ac5742aca274d1702e1f', type: 'text/javascript; charset=utf-8' },
  'vad.worklet.bundle.min.js': { pkg: 'vad-web', member: 'package/dist/vad.worklet.bundle.min.js', sha256: '8a48fdc7429948a2fde3d29a84bb1a64c1f67b4ba578ccaa7548b7f989f06a74', type: 'text/javascript; charset=utf-8' },
  'silero_vad_v5.onnx': { pkg: 'vad-web', member: 'package/dist/silero_vad_v5.onnx', sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f', type: 'application/octet-stream' },
  'ort.wasm.min.js': { pkg: 'onnxruntime-web', member: 'package/dist/ort.wasm.min.js', sha256: '65e09376df69107e881b5c34d2d37aed333a366b6d941073ec518168e269b87d', type: 'text/javascript; charset=utf-8' },
  'ort-wasm-simd-threaded.mjs': { pkg: 'onnxruntime-web', member: 'package/dist/ort-wasm-simd-threaded.mjs', sha256: '30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8', type: 'text/javascript; charset=utf-8' },
  'ort-wasm-simd-threaded.wasm': { pkg: 'onnxruntime-web', member: 'package/dist/ort-wasm-simd-threaded.wasm', sha256: '71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4', type: 'application/wasm' },
};

/**
 * Voices. `sid` is the speaker number inside the model (Kokoro v1.0 voice order); `model` the TTS model folder it needs;
 * `accent` for the picker ("US", "British", "Scottish"); `gb` selects the British Kokoro lexicon.
 */
const VOICES = [
  { id: 'af_heart', label: 'Heart (US, female)', engine: 'kokoro', accent: 'US', gender: 'female', sid: 3, model: 'kokoro-multi-lang-v1_0' },
  { id: 'am_michael', label: 'Michael (US, male)', engine: 'kokoro', accent: 'US', gender: 'male', sid: 16, model: 'kokoro-multi-lang-v1_0' },
  { id: 'bf_emma', label: 'Emma (British, female)', engine: 'kokoro', accent: 'British', gender: 'female', sid: 21, model: 'kokoro-multi-lang-v1_0', gb: true },
  { id: 'bm_george', label: 'George (British, male)', engine: 'kokoro', accent: 'British', gender: 'male', sid: 26, model: 'kokoro-multi-lang-v1_0', gb: true },
  { id: 'alba', label: 'Alba (Scottish, female)', engine: 'piper', accent: 'Scottish', gender: 'female', sid: 0, model: 'piper-en_GB-alba-medium' },
  { id: 'lessac', label: 'Lessac (US)', engine: 'piper', accent: 'US', gender: 'neutral', sid: 0, model: 'piper-en_US-lessac-medium' },
];
const VOICE_IDS = VOICES.map(v => v.id);
const DEFAULT_VOICE = 'af_heart';
const STT_MODELS = ['tiny.en', 'small.en'];
const DEFAULT_STT = 'tiny.en';   // when nothing was chosen; the speed check picks small.en on strong machines

const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_PACKAGE);

/** Merge a settings patch for `voice` onto the stored value: known keys only, values checked. Returns the full new object. */
function cleanVoiceSettings(patch, current) {
  const cur = current && typeof current === 'object' ? current : {};
  // '' means "automatic": the speed check's choice.
  const out = {
    enabled: cur.enabled === true,
    defaultVoice: VOICE_IDS.includes(cur.defaultVoice) ? cur.defaultVoice : '',
    sttModel: STT_MODELS.includes(cur.sttModel) ? cur.sttModel : '',
  };
  const p = patch && typeof patch === 'object' ? patch : {};
  if (p.enabled !== undefined) out.enabled = p.enabled === true;
  if (p.defaultVoice !== undefined && (p.defaultVoice === '' || VOICE_IDS.includes(p.defaultVoice))) out.defaultVoice = p.defaultVoice;
  if (p.sttModel !== undefined && (p.sttModel === '' || STT_MODELS.includes(p.sttModel))) out.sttModel = p.sttModel;
  return out;
}

/** Per-agent `voice` field: { voice: <local id>|'', stt: local|openai|google, tts: local|openai|google|elevenlabs, cloudVoice?, cloudConfirmedBy?, cloudConfirmedAt? }. Returns { ok, value } or { ok:false, error }. */
function cleanAgentVoice(value) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };   // back to the hub default
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'voice must be an object { voice, stt, tts }' };
  const voice = value.voice === undefined || value.voice === null ? '' : String(value.voice);
  if (voice && !VOICE_IDS.includes(voice)) return { ok: false, error: `voice must be one of: ${VOICE_IDS.join(', ')} (or empty for the hub default)` };
  const cloud = require('./cloud');
  const stt = value.stt === undefined || value.stt === null || value.stt === '' ? 'local' : value.stt;
  const tts = value.tts === undefined || value.tts === null || value.tts === '' ? 'local' : value.tts;
  if (!cloud.STT_ENGINES.includes(stt)) return { ok: false, error: `speech recognition must be one of: ${cloud.STT_ENGINES.join(', ')}` };
  if (!cloud.TTS_ENGINES.includes(tts)) return { ok: false, error: `voice engine must be one of: ${cloud.TTS_ENGINES.join(', ')}` };
  const out = { voice, stt, tts };
  // The cloud voice belongs to the cloud voice engine; it is kept only when that engine is chosen.
  if (tts === 'openai' || tts === 'google') {
    const list = tts === 'openai' ? cloud.OPENAI_VOICES : cloud.GOOGLE_VOICES;
    const cv = value.cloudVoice === undefined || value.cloudVoice === null || value.cloudVoice === '' ? cloud.DEFAULT_CLOUD_VOICE[tts] : String(value.cloudVoice);
    if (!list.includes(cv)) return { ok: false, error: `cloud voice for ${tts} must be one of: ${list.join(', ')}` };
    out.cloudVoice = cv;
  } else if (tts === 'elevenlabs') {
    const cv = value.cloudVoice === undefined || value.cloudVoice === null ? '' : String(value.cloudVoice).trim();
    if (!cv) return { ok: false, error: 'an ElevenLabs voice ID is required' };
    if (!cloud.ELEVENLABS_VOICE_RE.test(cv)) return { ok: false, error: 'the ElevenLabs voice ID must be 10 to 40 letters and digits' };
    out.cloudVoice = cv;
  }
  // Who confirmed a cloud engine for an agent kept on this computer, and when. Only meaningful while a cloud engine is chosen.
  if (stt !== 'local' || tts !== 'local') {
    if (typeof value.cloudConfirmedBy === 'string' && value.cloudConfirmedBy) out.cloudConfirmedBy = value.cloudConfirmedBy.slice(0, 80);
    if (out.cloudConfirmedBy && typeof value.cloudConfirmedAt === 'string' && value.cloudConfirmedAt) out.cloudConfirmedAt = value.cloudConfirmedAt.slice(0, 40);
  }
  return { ok: true, value: out };
}

module.exports = {
  SHERPA, SHERPA_VERSION, NODE_PACKAGES, PLATFORM_PACKAGE, platformPackage, MODELS, WEB_PACKAGES, WEB_FILES,
  VOICES, VOICE_IDS, DEFAULT_VOICE, STT_MODELS, DEFAULT_STT, SUPPORTED_PLATFORMS,
  cleanVoiceSettings, cleanAgentVoice,
};
