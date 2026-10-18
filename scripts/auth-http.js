'use strict';
// Human-only local provisioning.  Never paste credentials into an agent conversation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AuthHttp, DEFAULT_DIR, validateConfig } = require('../lib/tools/auth-http');
const dir = DEFAULT_DIR;
const command = process.argv[2];
function writePrivate(name, data) {
  const target = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${crypto.randomUUID()}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode:0o600,flag:'wx'});
  fs.renameSync(tmp, target);
}
function directory() {
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== process.getuid()) throw new Error('Private owned directory required');
}
function readPrivate(name) {
  directory();
  const file=path.join(dir,name), s=fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== process.getuid()) throw new Error('Private owned file required');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
async function main() {
  if (command === 'init') {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true,mode:0o700});
    directory();
    if (fs.existsSync(path.join(dir,'config.json')) || fs.existsSync(path.join(dir,'identities.json'))) throw new Error('Already initialized; existing files were not changed');
    writePrivate('config.json', {
      version:1, enabled:false, runId:`run-${crypto.randomUUID()}`,
      expiresAt:new Date(Date.now()+4*3600000).toISOString(),
      maxRequests:100, requestsPerMinute:30, concurrency:4, timeoutMs:15000, maxResponseBytes:65536,
      identities:{}, routes:{},
    });
    writePrivate('identities.json',{});
    console.log(`Created disabled configuration in ${dir}.  No identities or endpoints are provisioned.`);
  } else if (command === 'disable') {
    const c=readPrivate('config.json');c.enabled=false;writePrivate('config.json',c);
    console.log('Disabled.  In-flight requests may finish; new requests and post-probe tests are blocked.');
  } else if (command === 'validate') {
    const c=readPrivate('config.json');
    validateConfig({...c,enabled:true});
    if (!Object.keys(c.identities).length || !Object.keys(c.routes).length) throw new Error('Configure reviewed routes and identities first');
    const e=new AuthHttp({dir});
    try {
      for (const [name,i] of Object.entries(c.identities)) {
        e.credentials(name);
        for (const r of Object.values(c.routes).filter(r=>r.identities.includes(name))) {
          for (const agent of r.agents) e.route(c,i.probe.route,name,agent);
        }
      }
    } finally {e.close();}
    console.log('Local configuration, identity expiry and probe access validated.  No network requests made.  Authentication remains unverified until the first probe.');
  } else if (command === 'import-identity') {
    const name=process.argv[3];
    if (!name || !/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error('Supply configured identity name');
    const c=readPrivate('config.json');
    if (!Object.hasOwn(c.identities,name)) throw new Error('Add identity and reviewed probe to config.json first');
    if (process.stdin.isTTY) throw new Error('Read credential JSON from a protected file via stdin; do not type secrets into shell history');
    let input='';
    for await (const chunk of process.stdin) {input+=chunk;if(input.length>65536) throw new Error('Input exceeds size limit');}
    const value=JSON.parse(input), all=readPrivate('identities.json');
    if (!value || !value.headers || !Object.keys(value.headers).length || !['string','number'].includes(typeof value.expectedIdentity) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt)<=Date.now()) throw new Error('Expected headers, expectedIdentity and a future expiresAt');
    all[name]=value;writePrivate('identities.json',all);
    console.log('Identity imported locally.  No credentials printed or network requests made.  Run validate next.');
  } else if (command === 'status') {
    const e=new AuthHttp({dir});try {console.log(JSON.stringify(e.status({agentName:process.argv[3] || 'main'}),null,2));}finally{e.close();}
  } else {
    console.log('Usage: node scripts/auth-http.js init | validate | status [agent-slug] | disable | import-identity <name> < protected-identity.json');
    console.log('Enable only after human scope review by setting enabled:true in the private config.  This CLI never enables a run or exports credentials.');
  }
}
main().catch(()=>{console.error('Local provisioning failed.  Check the command, private file permissions, required fields, expiry and the setup guide.  Error details are suppressed to avoid exposing credentials.');process.exitCode=1;});
