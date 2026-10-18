'use strict';
const { preserve } = require('../tiger-team-artifacts');

// Direct authenticated testing.  Credentials never belong in tool arguments.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DEFAULT_DIR = path.join(os.homedir(), '.config', 'agent-hub-http');
const SENSITIVE = /authorization|cookie|token|secret|password|credential|session|csrf|private.?key|api.?key|email|phone|address|balance/i;
const SAFE_HEADERS = new Set(['accept', 'content-type', 'accept-language']);
const BAD_AUTH_HEADERS = /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|forwarded|x-forwarded-.*|accept-encoding)$/i;
const OMIT_HEADERS = new Set(['set-cookie', 'cookie', 'authorization', 'location', 'www-authenticate']);
const fail = code => { const e = new Error(code); e.safeCode = code; throw e; };
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const validName = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x);
const own = (x, k) => plain(x) && Object.hasOwn(x, k);
function integer(x, lo, hi) { return Number.isInteger(x) && x >= lo && x <= hi; }
function privateFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || (s.mode & 0o077) || s.uid !== process.getuid()) fail('PRIVATE_FILE_REQUIRED');
    if (s.size > 1024 * 1024) fail('CONFIG_TOO_LARGE');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function privateDir(dir) {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== process.getuid()) fail('PRIVATE_DIRECTORY_REQUIRED');
}
function validOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && u.origin === origin && !u.username && !u.password && !net.isIP(u.hostname) && !u.hostname.startsWith('[');
  } catch { return false; }
}
function pointer(obj, p) {
  if (p === '') return obj;
  if (typeof p !== 'string' || !p.startsWith('/')) return undefined;
  return p.slice(1).split('/').reduce((v, k) => {
    k = k.replace(/~1/g, '/').replace(/~0/g, '~');
    return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
  }, obj);
}
function scrub(value, secrets) {
  const replace = text => {
    for (const s of secrets) {
      if (!s) continue;
      for (const variant of [s, encodeURIComponent(s), Buffer.from(s).toString('base64')]) text = text.split(variant).join('[REDACTED]');
    }
    return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
      .replace(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi, '[REDACTED_EMAIL]');
  };
  function visit(x, depth = 0) {
    if (depth > 40) return '[DEPTH_LIMIT]';
    if (typeof x === 'string') return replace(x);
    if (Array.isArray(x)) return x.map(v => visit(v, depth + 1));
    if (plain(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [replace(k), SENSITIVE.test(k) ? '[REDACTED]' : visit(v, depth + 1)]));
    return x;
  }
  return visit(value);
}
function secretValues(headers) {
  const out = Object.values(headers).map(String);
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'cookie') for (const pair of v.split(';')) out.push(pair.slice(pair.indexOf('=') + 1).trim());
    if (k.toLowerCase() === 'authorization') out.push(v.replace(/^\S+\s+/, ''));
  }
  return out.filter(Boolean);
}
const blocked = new net.BlockList();
for (const [a, n] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(a, n);
function publicIPv4(ip) { return net.isIPv4(ip) && !blocked.check(ip); }

async function transport({ url, method, headers, body, timeoutMs, maxBytes }) {
  // Pin validated DNS results to the TLS connection.  No redirects or proxy inheritance.
  let timer;
  const lookup = dns.lookup(url.hostname, { all: true, family: 4 });
  const records = await Promise.race([lookup, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
  if (!records.length || records.some(r => !publicIPv4(r.address))) fail('NON_PUBLIC_DESTINATION');
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method, headers: { ...headers, 'accept-encoding': 'identity' }, agent: false,
      signal: AbortSignal.timeout(timeoutMs),
      lookup: (_host, options, cb) => options.all ? cb(null, [records[0]]) : cb(null, records[0].address, 4),
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', b => {
        size += b.length;
        if (size > maxBytes) { req.destroy(new Error('RESPONSE_TOO_LARGE')); return; }
        chunks.push(b);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function validateConfig(c) {
  if (!plain(c) || c.version !== 1 || typeof c.enabled !== 'boolean') fail('INVALID_CONFIG');
  if (!c.enabled) return c;
  if (!validName(c.runId) || !Number.isFinite(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= Date.now()) fail('RUN_EXPIRED_OR_INVALID');
  if (!integer(c.maxRequests,1,10000) || !integer(c.requestsPerMinute,1,120) || !integer(c.concurrency,1,8)) fail('INVALID_BUDGET');
  if (!integer(c.timeoutMs,100,30000) || !integer(c.maxResponseBytes,1024,262144)) fail('INVALID_RESPONSE_LIMITS');
  if (!plain(c.identities) || !plain(c.routes)) fail('INVALID_SCOPE');
  for (const [name, i] of Object.entries(c.identities)) {
    if (!validName(name) || !validOrigin(i.origin) || !plain(i.probe) || !validName(i.probe.route) || typeof i.probe.pointer !== 'string' || !i.probe.pointer.startsWith('/')) fail('INVALID_IDENTITY');
    const r = c.routes[i.probe.route];
    if (!r || r.method !== 'GET' || r.origin !== i.origin || r.path.includes('{')) fail('INVALID_AUTH_PROBE');
  }
  for (const [name, r] of Object.entries(c.routes)) {
    if (!validName(name) || !validOrigin(r.origin) || typeof r.path !== 'string' || !/^\/(?!\/)[a-zA-Z0-9_/{\}.~-]*$/.test(r.path) || r.path.includes('..')) fail('INVALID_ROUTE');
    if (!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(r.method)) fail('INVALID_METHOD');
    if (!Array.isArray(r.identities) || !r.identities.length || r.identities.some(n => !own(c.identities, n) || c.identities[n].origin !== r.origin)) fail('INVALID_ROUTE_IDENTITIES');
    if (!Array.isArray(r.agents) || !r.agents.length || r.agents.some(n => !validName(n))) fail('INVALID_ROUTE_AGENTS');
    // Every endpoint requires human review, including GET endpoints with side effects.
    if (r.reviewed !== true) fail('UNREVIEWED_ROUTE');
    if (!['GET','HEAD'].includes(r.method) && !(typeof r.approval === 'string' && r.approval.trim().length >= 8)) fail('WRITE_APPROVAL_REQUIRED');
    if (!Array.isArray(r.queryKeys) || r.queryKeys.some(k => typeof k !== 'string' || SENSITIVE.test(k))) fail('INVALID_QUERY_KEYS');
    if (r.graphql !== undefined && (r.method !== 'POST' || !plain(r.graphql) || typeof r.graphql.document !== 'string' || !r.graphql.document.trim() || typeof r.graphql.operationName !== 'string')) fail('INVALID_GRAPHQL');
  }
  return c;
}

class AuthHttp {
  constructor({ dir = DEFAULT_DIR, send = transport } = {}) { this.dir = dir; this.send = send; this.active = 0; this.db = null; }
  config() { privateDir(this.dir); return validateConfig(privateFile(path.join(this.dir, 'config.json'))); }
  database() {
    if (!this.db) {
      const file = path.join(this.dir, 'evidence.sqlite');
      if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'wx', 0o600));
      const s = fs.lstatSync(file);
      if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== process.getuid()) fail('PRIVATE_DATABASE_REQUIRED');
      this.db = new Database(file);
      this.db.pragma('busy_timeout = 3000');
      this.db.exec(`CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, run TEXT NOT NULL, ts INTEGER NOT NULL, agent TEXT NOT NULL,
        identity_name TEXT NOT NULL, route TEXT NOT NULL, purpose TEXT NOT NULL, result TEXT);
        CREATE INDEX IF NOT EXISTS requests_run_ts ON requests(run, ts);
        CREATE TABLE IF NOT EXISTS halted (run TEXT PRIMARY KEY, reason TEXT NOT NULL);`);
    }
    return this.db;
  }
  reserve(c, agent, identity, route, purpose) {
    const db = this.database();
    return db.transaction(() => {
      if (db.prepare('SELECT 1 FROM halted WHERE run = ?').get(c.runId)) fail('RUN_HALTED');
      const total = db.prepare('SELECT count(*) AS n FROM requests WHERE run = ?').get(c.runId).n;
      const recent = db.prepare('SELECT count(*) AS n FROM requests WHERE run = ? AND ts > ?').get(c.runId, Date.now() - 60000).n;
      if (total >= c.maxRequests) fail('REQUEST_BUDGET_EXHAUSTED');
      if (recent >= c.requestsPerMinute) fail('RATE_LIMITED');
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO requests(id,run,ts,agent,identity_name,route,purpose) VALUES(?,?,?,?,?,?,?)').run(id,c.runId,Date.now(),agent,identity,route,purpose);
      return id;
    }).immediate();
  }
  halt(c, reason) { this.database().prepare('INSERT OR REPLACE INTO halted(run,reason) VALUES(?,?)').run(c.runId, reason); }
  save(id, result) { this.database().prepare('UPDATE requests SET result = ? WHERE id = ?').run(JSON.stringify(result), id); }
  credentials(identity) {
    const all = privateFile(path.join(this.dir, 'identities.json'));
    const i = own(all, identity) ? all[identity] : null;
    if (!i || !plain(i.headers) || !Object.keys(i.headers).length || !['string','number'].includes(typeof i.expectedIdentity) || i.expectedIdentity === '') fail('IDENTITY_NOT_PROVISIONED');
    if (!Number.isFinite(Date.parse(i.expiresAt)) || Date.parse(i.expiresAt) <= Date.now()) fail('CREDENTIALS_EXPIRED');
    const headers = {};
    for (const [key, value] of Object.entries(i.headers)) {
      if (!/^[a-zA-Z0-9-]+$/.test(key) || BAD_AUTH_HEADERS.test(key) || typeof value !== 'string' || !value || /[\r\n]/.test(value)) fail('INVALID_CREDENTIAL_HEADERS');
      headers[key.toLowerCase()] = value;
    }
    return { headers, expected: i.expectedIdentity, secrets: secretValues(headers) };
  }
  route(c, name, identity, agent) {
    const r = own(c.routes, name) ? c.routes[name] : null;
    if (!r || !r.identities.includes(identity) || !r.agents.includes(agent)) fail('ROUTE_NOT_AUTHORIZED');
    return r;
  }
  prepare(c, args, agent, cred) {
    const r = this.route(c, args.route, args.identity, agent);
    let pathname = r.path;
    const params = args.path_params || {};
    if (!plain(params)) fail('INVALID_PATH_PARAMS');
    for (const [k,v] of Object.entries(params)) {
      if (!validName(k) || typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(v) || !pathname.includes(`{${k}}`)) fail('INVALID_PATH_PARAM');
      pathname = pathname.split(`{${k}}`).join(v);
    }
    if (/[{}]/.test(pathname)) fail('MISSING_PATH_PARAM');
    const url = new URL(pathname, r.origin);
    if (url.origin !== r.origin || url.pathname !== pathname) fail('OUT_OF_SCOPE');
    if (args.query !== undefined && !plain(args.query)) fail('INVALID_QUERY');
    for (const [k,v] of Object.entries(args.query || {})) {
      if (!r.queryKeys.includes(k) || !['string','number','boolean'].includes(typeof v)) fail('QUERY_KEY_NOT_AUTHORIZED');
      url.searchParams.set(k, String(v));
    }
    if (url.href.length > 8192) fail('URL_TOO_LARGE');
    const headers = { accept: 'application/json' };
    if (args.headers !== undefined && !plain(args.headers)) fail('INVALID_HEADERS');
    for (const [key, value] of Object.entries(args.headers || {})) {
      const k = key.toLowerCase();
      if (!SAFE_HEADERS.has(k) || typeof value !== 'string' || /[\r\n]/.test(value)) fail('HEADER_NOT_AUTHORIZED');
      headers[k] = value;
    }
    let body;
    if (r.graphql) {
      if (args.body !== undefined || (args.variables !== undefined && !plain(args.variables))) fail('USE_GRAPHQL_VARIABLES');
      body = JSON.stringify({ query: r.graphql.document, operationName: r.graphql.operationName, variables: args.variables || {} });
    } else {
      if (args.variables !== undefined) fail('NOT_GRAPHQL_ROUTE');
      if (args.body !== undefined) {
        if (['GET','HEAD'].includes(r.method)) fail('BODY_NOT_ALLOWED');
        body = JSON.stringify(args.body);
      }
    }
    if (body !== undefined) {
      if (Buffer.byteLength(body) > 65536) fail('REQUEST_BODY_TOO_LARGE');
      headers['content-type'] = 'application/json';
    }
    return { url, method: r.method, headers: { ...headers, ...cred.headers }, body, timeoutMs: c.timeoutMs, maxBytes: c.maxResponseBytes };
  }
  async wire(c, args, agent, cred, purpose) {
    const fresh = this.credentials(args.identity);
    if (JSON.stringify(fresh) !== JSON.stringify(cred)) fail('CREDENTIALS_CHANGED');
    const req = this.prepare(c, args, agent, fresh);
    // Recheck the on-disk kill switch before every network request, including after a probe.
    const current = this.config();
    if (!current.enabled || JSON.stringify(current) !== JSON.stringify(c)) fail('CONFIG_CHANGED_OR_DISABLED');
    const id = this.reserve(c, agent, args.identity, args.route, purpose);
    const started = Date.now();
    let res;
    try { res = await this.send(req); }
    catch {
      this.halt(c, 'TRANSPORT_FAILURE');
      this.save(id, { error: 'TRANSPORT_FAILURE', elapsedMs: Date.now() - started });
      fail('TRANSPORT_FAILURE_RUN_HALTED');
    }
    const meta = { evidenceId: id, status: res.status, elapsedMs: Date.now() - started, bytes: Buffer.byteLength(res.text) };
    if (res.status === 401 || (res.status >= 300 && res.status < 400) || res.status === 429) {
      this.halt(c, 'AUTH_REDIRECT_OR_RATE_LIMIT');
      this.save(id, { ...meta, error: 'AUTH_REDIRECT_OR_RATE_LIMIT' });
      fail('AUTH_REDIRECT_OR_RATE_LIMIT_RUN_HALTED');
    }
    let json;
    try { json = JSON.parse(res.text); } catch { /* Non-JSON bodies are intentionally withheld. */ }
    const graphErrors = Array.isArray(json?.errors) ? json.errors : [];
    const authError = graphErrors.some(e => ['UNAUTHENTICATED', 'UNAUTHORIZED', 'AUTHENTICATION_REQUIRED', 'SESSION_EXPIRED'].includes(e?.extensions?.code));
    const unexpectedText = purpose === 'test' && req.method !== 'HEAD' && res.status >= 200 && res.status < 300 && res.status !== 204 && json === undefined;
    if (authError || unexpectedText) {
      this.halt(c, 'AUTH_ERROR_OR_UNEXPECTED_BODY');
      this.save(id, { ...meta, error: 'AUTH_ERROR_OR_UNEXPECTED_BODY' });
      fail('AUTH_ERROR_OR_UNEXPECTED_BODY_RUN_HALTED');
    }
    const result = { ...meta, headers: {}, body: '[NON_JSON_BODY_WITHHELD]', auth_note: purpose === 'probe' ? 'probe' : 'preflight_verified_not_proof_of_target_auth' };
    for (const [k,v] of Object.entries(res.headers)) {
      if (!OMIT_HEADERS.has(k.toLowerCase()) && ['content-type','content-length','x-request-id','retry-after'].includes(k.toLowerCase())) result.headers[k] = scrub(v, cred.secrets);
    }
    if (purpose === 'probe') {
      const p = c.identities[args.identity].probe;
      if (res.status !== 200 || pointer(json, p.pointer) !== cred.expected) {
        this.halt(c, 'AUTH_PROBE_FAILED');
        this.save(id, { ...meta, error: 'AUTH_PROBE_FAILED' });
        fail('AUTH_PROBE_FAILED_RUN_HALTED');
      }
      result.body = '[IDENTITY_VERIFIED_BODY_WITHHELD]';
    } else if (json !== undefined) result.body = scrub(json, cred.secrets);
    if (purpose === 'test') {
      const requestEvidence = scrub({ method: req.method, origin: req.url.origin, path: req.url.pathname,
        query: Object.fromEntries(req.url.searchParams), body: req.body ? JSON.parse(req.body) : null }, cred.secrets);
      preserve(requestEvidence, 'auth_http:redacted-request');
      const serialized = JSON.stringify(requestEvidence);
      result.request = serialized.length <= 8000 ? requestEvidence : { redactedPreview: serialized.slice(0,8000), truncated:true };
    }
    preserve(result, 'auth_http:redacted-response');
    const serializedBody = JSON.stringify(result.body);
    if (serializedBody.length > 24000) { result.body = serializedBody.slice(0,24000); result.bodyTruncated = true; }
    // Only redacted request/response evidence; no auth headers or raw payloads on disk.
    this.save(id, result);
    return result;
  }
  async request(args, { agentName } = {}) {
    let acquired = false;
    try {
      const c = this.config();
      if (!c.enabled) fail('DISABLED');
      if (!validName(agentName) || !plain(args) || !own(c.identities,args.identity)) fail('INVALID_IDENTITY_OR_AGENT');
      if (Object.keys(args).some(k => !['identity','route','path_params','query','headers','body','variables'].includes(k))) fail('UNKNOWN_ARGUMENT');
      const cred = this.credentials(args.identity);
      this.prepare(c, args, agentName, cred);
      if (this.active >= c.concurrency) fail('CONCURRENCY_LIMIT_RETRY_LATER');
      this.active++; acquired = true;
      const probeArgs = { identity: args.identity, route: c.identities[args.identity].probe.route };
      const probe = await this.wire(c, probeArgs, agentName, cred, 'probe');
      if (args.route === probeArgs.route) return { ok: true, ...probe };
      const result = await this.wire(c, args, agentName, cred, 'test');
      return { ok: true, ...result, probeEvidenceId: probe.evidenceId };
    } catch (e) { if (e.code === 'TT_PERSISTENCE_FAILED') throw e; return { ok: false, error: e.safeCode || 'LOCAL_CONFIGURATION_OR_IO_ERROR' }; }
    finally { if (acquired) this.active--; }
  }
  status({ agentName } = {}) {
    try {
      const c = this.config();
      if (!c.enabled) return { enabled: false, message: 'Human scope review and local credential provisioning required.' };
      const db = this.database();
      return { enabled: true, runId: c.runId, expiresAt: c.expiresAt, active: this.active,
        usedRequests: db.prepare('SELECT count(*) AS n FROM requests WHERE run = ?').get(c.runId).n,
        maxRequests: c.maxRequests, requestsPerMinute: c.requestsPerMinute, concurrency: c.concurrency,
        halted: !!db.prepare('SELECT 1 FROM halted WHERE run = ?').get(c.runId),
        routes: Object.entries(c.routes).filter(([,r]) => r.agents.includes(agentName)).map(([name,r]) => ({ name, method:r.method, origin:r.origin, path:r.path, identities:r.identities, queryKeys:r.queryKeys, graphql:!!r.graphql })),
      };
    } catch (e) { return { enabled:false, error:e.safeCode || 'NOT_CONFIGURED' }; }
  }
  close() { if (this.db) this.db.close(); this.db = null; }
}
let singleton;
function executor() { return singleton || (singleton = new AuthHttp()); }
const object = { type: 'object', additionalProperties: true };
const tools = {
  auth_http_status: {
    description: 'List authorized direct HTTP test routes, named identities, persistent request budgets and halt state.  No credentials returned.  Human must provision local scope first.  Load category auth_http.',
    parameters: { type:'object', properties:{}, required:[] },
    handler: (_args, context) => executor().status(context),
  },
  auth_http_request: {
    description: 'Execute a scoped authenticated HTTP or GraphQL test using a named local identity.  Auth probe runs first.  Route fixes origin, method and GraphQL document; vary approved query keys, path parameters, JSON body or GraphQL variables.  No credentials in arguments.  JSON evidence is redacted; non-JSON withheld.  Never retry a halted run.',
    parameters: { type:'object', properties: {
      identity:{ type:'string', description:'Provisioned identity name from auth_http_status' },
      route:{ type:'string', description:'Reviewed route name from auth_http_status' },
      path_params:{ ...object, description:'Values for named route path placeholders; alphanumeric, underscore and hyphen only' },
      query:{ ...object, description:'Only query keys explicitly approved for this route' },
      headers:{ ...object, description:'Optional Accept, Accept-Language or Content-Type only; no auth headers' },
      body:{ ...object, description:'JSON body for an approved non-GraphQL write route' },
      variables:{ ...object, description:'Variables for the route fixed GraphQL document' },
    }, required:['identity','route'] },
    handler: (args, context) => executor().request(args, context),
  },
};
module.exports = { AuthHttp, tools, DEFAULT_DIR, validateConfig, scrub, publicIPv4, transport };
