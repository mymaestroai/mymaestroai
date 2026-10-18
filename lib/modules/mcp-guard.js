#!/usr/bin/env node
'use strict';
/**
 * mcp-guard: the process a module's connector runs. It starts the module's real tool server and sits between it
 * and the hub, speaking MCP over stdio (one JSON message per line) in both directions:
 *   - tools/list: only the tools the manifest lists with a class other than "off" are shown. A tool a new
 *     package version adds stays hidden until a person classifies it in module.json.
 *   - tools/call: hidden tools are refused; for the rest the module's own guard() (modules/<id>/index.js)
 *     decides with the current settings (read fresh on every call, so a limit change applies at once), today's
 *     usage and a price lookup. Money calls are handled one at a time so a daily cap cannot be overrun by
 *     parallel calls. Every non-read call is written to data/modules/<id>/audit.jsonl.
 * Usage: node mcp-guard.js <module id> --root <modules dir> --data <modules data dir> --state <modules.json>
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadModule, safeSettings } = require('./manifest');
const { binPath } = require('./installer');

function arg(name, dflt) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; }
const HUB = path.join(__dirname, '..', '..');
const id = process.argv[2];
const ROOT = arg('root', path.join(HUB, 'modules'));
const DATA = arg('data', path.join(HUB, 'data', 'modules'));
const STATE = arg('state', path.join(HUB, 'data', 'modules.json'));
const CONNECTORS = arg('connectors', path.join(HUB, 'data', 'connectors.json'));
const MAX_LINE = 16 * 1024 * 1024;

function fail(msg) { process.stderr.write(`[mcp-guard ${id}] ${msg}\n`); process.exit(1); }
const mod = loadModule(path.join(ROOT, String(id || '')));
if (!mod.manifest) fail(`module "${id}" not found in ${ROOT}`);
if (mod.problems.length) fail(`module "${id}" is invalid: ${mod.problems.join('; ')}`);
const { manifest, code } = mod;
const tools = manifest.tools || {};
const classOf = (name) => tools[name] || 'off';

const home = process.env.CONNECTOR_DATA_HOME || path.join(DATA, id, 'home');
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const modData = path.join(DATA, id);

// ── the real server ──
const srv = manifest.server;
let cmd, cmdArgs;
if (srv.npm) {
  const bin = binPath(DATA, id, srv.npm);
  if (!bin) fail(`${srv.npm.package}@${srv.npm.version} is not installed; run the module's setup (Install step)`);
  cmd = process.execPath; cmdArgs = [bin, ...(srv.args || [])];
} else { cmd = process.execPath; cmdArgs = [path.join(mod.dir, srv.script), ...(srv.args || [])]; }
const env = { ...process.env, ...(srv.env || {}), HOME: home };
if (srv.dataEnv) env[srv.dataEnv] = home;
const child = spawn(cmd, cmdArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', d => process.stderr.write(d));
child.on('exit', (code) => process.exit(code == null ? 1 : code));
process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} process.exit(0); });
process.stdin.on('end', () => { try { child.kill('SIGTERM'); } catch {} });
process.stdin.setEncoding('utf8');      // whole characters, even when a chunk splits one
child.stdout.setEncoding('utf8');
// Secret values never reach the activity log.
const secretValues = (manifest.secrets || []).map(x => process.env[x.name]).filter(v => typeof v === 'string' && v.length >= 6);
const redact = (v) => { let t = typeof v === 'string' ? v : JSON.stringify(v); if (t === undefined) return t; for (const sv of secretValues) t = t.split(sv).join('[secret]'); return t; };

const toParent = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const toChild = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

// ── state the guard reads and keeps ──
// Settings are read fresh on every call and checked against the manifest: a missing or invalid value falls back
// to the manifest default (which is always the safe one), never to "no limit".
function settings() {
  let raw = {};
  try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); raw = (s.modules && s.modules[id] && s.modules[id].settings) || {}; } catch {}
  return safeSettings(manifest, raw);
}
// The module is switched off (or its connector removed): no money call goes through, even one already queued.
function switchedOn() {
  try { const c = (JSON.parse(fs.readFileSync(CONNECTORS, 'utf8')).connectors || []).find(x => x.id === id); return !!(c && c.enabled); } catch { return false; }
}
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const usageFile = path.join(modData, 'usage.json');
const usage = {
  today() { try { const u = JSON.parse(fs.readFileSync(usageFile, 'utf8')); return u.day === day() ? u.totals || {} : {}; } catch { return {}; } },
  add(totals, sign = 1) {
    const t = usage.today();
    for (const [k, v] of Object.entries(totals || {})) t[k] = Math.max(0, (Number(t[k]) || 0) + sign * (Number(v) || 0));
    fs.mkdirSync(modData, { recursive: true, mode: 0o700 });
    const tmp = `${usageFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ day: day(), totals: t }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, usageFile);
  },
};
function audit(rec) {
  try { fs.mkdirSync(modData, { recursive: true, mode: 0o700 }); fs.appendFileSync(path.join(modData, 'audit.jsonl'), redact({ ts: new Date().toISOString(), ...rec }) + '\n', { mode: 0o600 }); } catch {}
}

// calls the guard makes to the real server (e.g. to look something up before deciding)
let internalSeq = 0;
const internal = new Map();
function callChild(name, args) {
  const rid = `guard-${++internalSeq}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { internal.delete(rid); reject(new Error('the tool server did not answer')); }, 30000);
    internal.set(rid, (msg) => { clearTimeout(t); msg.error ? reject(new Error(msg.error.message || 'error')) : resolve(msg.result); });
    toChild({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args || {} } });
  });
}
// Text of a tool result; an error result throws (a guard lookup that fails must not be read as data).
async function callText(name, args) {
  const r = await callChild(name, args);
  const text = r && Array.isArray(r.content) ? r.content.map(c => c.text || '').join('\n') : JSON.stringify(r);
  if (r && r.isError) throw new Error(String(text).slice(0, 200));
  return text;
}
async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}

// ── traffic ──
const listIds = new Set();
const watched = new Map();   // parent request id -> { name, cls, decision, args }
let chain = Promise.resolve();

function refuse(msgId, text) { toParent({ jsonrpc: '2.0', id: msgId, result: { content: [{ type: 'text', text }], isError: true } }); }

async function onCall(msg) {
  const name = msg.params && msg.params.name;
  const args = (msg.params && msg.params.arguments) || {};
  const cls = classOf(name);
  if (cls === 'off') { audit({ tool: name, decision: 'hidden' }); return refuse(msg.id, `${manifest.name}: the tool "${name}" is not enabled in this hub.`); }
  if (cls === 'money' && !switchedOn()) { audit({ tool: name, cls, decision: 'refused', reason: 'module switched off' }); return refuse(msg.id, `${manifest.name} is switched off in this hub.`); }
  let decision = { allow: true };
  if (typeof code.guard === 'function') {
    try { decision = (await code.guard({ name, args, cls }, { settings: settings(), usage: usage.today(), callTool: callChild, callText, fetchJson, manifest })) || { allow: true }; }
    catch (e) { decision = { allow: false, reason: `the limit check failed (${e.message}); refused to be safe` }; }
  } else if (cls === 'money') decision = { allow: false, reason: 'this module has no limit rules (index.js guard), so money tools are refused' };
  if (!decision.allow) {
    audit({ tool: name, cls, decision: 'refused', reason: decision.reason, args });
    return refuse(msg.id, `Refused by this hub's limits for ${manifest.name}: ${decision.reason}`);
  }
  // A guard may tighten the arguments (e.g. cap a spending limit); it never sees them loosened.
  if (decision.args && typeof decision.args === 'object') msg = { ...msg, params: { ...msg.params, arguments: decision.args } };
  // Reserve before the call goes out; given back only on an explicit failure. A call that never answers stays counted.
  if (decision.record) usage.add(decision.record);
  if (cls !== 'read') { watched.set(msg.id, { name, cls, decision, args: msg.params.arguments }); audit({ tool: name, cls, decision: 'allowed', note: decision.note, args: msg.params.arguments }); }
  toChild(msg);
  if (cls === 'money') await new Promise(resolve => { watched.get(msg.id).done = resolve; });   // the next money call waits for this answer
}

let pbuf = '';
process.stdin.on('data', (d) => {
  pbuf += d; let i;
  if (pbuf.length > MAX_LINE && pbuf.indexOf('\n') < 0) { pbuf = ''; return; }
  while ((i = pbuf.indexOf('\n')) >= 0) {
    const line = pbuf.slice(0, i).trim(); pbuf = pbuf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (Array.isArray(msg)) { toParent({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batched requests are not accepted' } }); continue; }
    if (!msg || typeof msg !== 'object') continue;
    if (typeof msg.id === 'string' && msg.id.startsWith('guard-')) { toParent({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'reserved request id' } }); continue; }
    if (msg.method === 'tools/list') { listIds.add(msg.id); toChild(msg); continue; }
    if (msg.method === 'tools/call') {
      if (msg.id === undefined || msg.id === null) continue;                       // a call without an id cannot be answered or accounted
      if (watched.has(msg.id)) { refuse(msg.id, `${manifest.name}: request id already in use`); continue; }
      const cls = classOf(msg.params && msg.params.name);
      const run = () => onCall(msg).catch((e) => refuse(msg.id, `${manifest.name}: ${e.message}`));
      if (cls === 'money') chain = chain.then(run);
      else run();
      continue;
    }
    if (typeof msg.method === 'string' && msg.method.startsWith('tools/')) { toParent({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: `${msg.method} is not passed through` } }); continue; }
    toChild(msg);
  }
});

let cbuf = '';
child.stdout.on('data', (d) => {
  cbuf += d; let i;
  if (cbuf.length > MAX_LINE && cbuf.indexOf('\n') < 0) { cbuf = ''; return; }
  while ((i = cbuf.indexOf('\n')) >= 0) {
    const line = cbuf.slice(0, i).trim(); cbuf = cbuf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); continue; }
    if (msg.id != null && internal.has(msg.id)) { const f = internal.get(msg.id); internal.delete(msg.id); f(msg); continue; }
    if (msg.id != null && listIds.has(msg.id)) {
      listIds.delete(msg.id);
      if (msg.result && Array.isArray(msg.result.tools)) msg.result.tools = msg.result.tools.filter(t => classOf(t.name) !== 'off');
    }
    if (msg.id != null && watched.has(msg.id)) {
      const w = watched.get(msg.id); watched.delete(msg.id);
      const ok = !!msg.result && !msg.result.isError;
      if (!ok && w.decision.record) usage.add(w.decision.record, -1);    // explicit failure: give the reservation back
      const text = msg.result && Array.isArray(msg.result.content) ? msg.result.content.map(c => c.text || '').join(' ').slice(0, 500) : (msg.error && msg.error.message) || '';
      audit({ tool: w.name, cls: w.cls, decision: ok ? 'done' : 'failed', record: ok ? w.decision.record : undefined, result: w.decision.quietResult ? '(not logged)' : text });
      if (w.done) w.done();
    }
    toParent(msg);
  }
});
