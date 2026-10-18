'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuthHttp, scrub, publicIPv4, validateConfig } = require('../lib/tools/auth-http');

function fixture(t, customize = () => {}, send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-http-test-'));
  fs.chmodSync(dir, 0o700);
  const route = { origin:'https://test.example', path:'/me', method:'GET', identities:['alice'], agents:['main'], queryKeys:[], reviewed:true };
  const config = { version:1, enabled:true, runId:'unit-test', expiresAt:new Date(Date.now()+600000).toISOString(), maxRequests:40, requestsPerMinute:40, concurrency:2, timeoutMs:500, maxResponseBytes:4096,
    identities:{ alice:{ origin:route.origin, probe:{ route:'me', pointer:'/id' } } },
    routes:{ me:route, item:{...route,path:'/items/{id}',queryKeys:['view']}, write:{...route,path:'/write',method:'POST',approval:'Operator test fixture approval'}, gql:{...route,path:'/graphql',method:'POST',approval:'Operator test fixture approval',graphql:{document:'query Item($id: ID!) { item(id: $id) { id } }',operationName:'Item'}} }
  };
  customize(config);
  const identity = { alice:{ headers:{Cookie:'sid=fixture-secret',Authorization:'Bearer fixture-bearer'}, expectedIdentity:'alice-id', expiresAt:config.expiresAt } };
  const write = (name, data) => fs.writeFileSync(path.join(dir,name),JSON.stringify(data),{mode:0o600});
  write('config.json',config); write('identities.json',identity);
  const calls=[];
  const executor = new AuthHttp({ dir, send: async req => {
    calls.push(req);
    if (send) return send(req, {write, config, identity, calls});
    return {status:200,headers:{'content-type':'application/json'},text:JSON.stringify(req.url.pathname==='/me'?{id:'alice-id'}:{ok:true})};
  } });
  t.after(()=>{executor.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request = args => executor.request({identity:'alice',route:'item',path_params:{id:'123'},...args},{agentName:'main'});
  return {dir,executor,request,calls,config,identity,write};
}

test('disabled by default and no network', async t=>{
  const f=fixture(t,c=>{c.enabled=false;});
  assert.equal((await f.request()).error,'DISABLED');assert.equal(f.calls.length,0);
});
test('inject local auth, probe first, exact route and redacted evidence',async t=>{
  const f=fixture(t,()=>{},async req=>({status:200,headers:{'set-cookie':'new=hidden','x-request-id':'req1'},text:JSON.stringify(req.url.pathname==='/me'?{id:'alice-id'}:{echo:'fixture-secret fixture-bearer',access_token:'new-secret',email:'person@example.invalid',nested:{sessionId:'new-session'}})}));
  const result=await f.request({query:{view:'full'}});
  assert.equal(result.ok,true);assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].headers.cookie,'sid=fixture-secret');
  assert.equal(f.calls[1].url.href,'https://test.example/items/123?view=full');
  const disk=JSON.stringify(f.executor.database().prepare('SELECT * FROM requests').all());
  for(const secret of ['fixture-secret','fixture-bearer','new-secret','person@example.invalid','new-session','new=hidden']) {
    assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!disk.includes(secret));
  }
  assert.equal(f.executor.status({agentName:'main'}).usedRequests,2);
});
test('unknown identity and caller context cannot access scope',async t=>{
  const f=fixture(t);
  assert.equal((await f.request({identity:'toString'})).ok,false);
  assert.equal((await f.executor.request({identity:'alice',route:'me'},{agentName:'other'})).error,'ROUTE_NOT_AUTHORIZED');
  assert.equal((await f.executor.request({identity:'alice',route:'me'})).ok,false);
  assert.equal(f.calls.length,0);
});
test('path traversal, headers, unknown query keys and direct URL all blocked',async t=>{
  const f=fixture(t);
  for(const args of [{path_params:{id:'../admin'}},{path_params:{id:'%2fadmin'}},{path_params:{id:'a/b'}},{headers:{Host:'evil.example'}},{headers:{Authorization:'bad'}},{headers:{'X-HTTP-Method-Override':'DELETE'}},{headers:{accept:'a\r\nb'}},{query:{token:'secret'}},{url:'https://evil.example'},{body:{x:1}},{route:'__proto__'}]) assert.equal((await f.request(args)).ok,false,JSON.stringify(args));
  assert.equal(f.calls.length,0);
});
test('unreviewed routes, writes lacking approval and literal-IP origins rejected',t=>{
  const f=fixture(t);
  for(const change of [c=>c.routes.item.reviewed=false,c=>delete c.routes.write.approval,c=>c.routes.me.origin='https://127.0.0.1',c=>c.routes.me.origin='https://[::1]',c=>c.routes.item.path='//evil.example',c=>c.routes.item.path='/a/../b']) {
    const c=structuredClone(f.config);change(c);assert.throws(()=>validateConfig(c));
  }
});
test('auth probe mismatch halts persistently and withholds raw body',async t=>{
  const f=fixture(t,()=>{},async()=>({status:200,headers:{},text:'{"id":"somebody-else","secret":"do-not-return"}'}));
  assert.equal((await f.request()).error,'AUTH_PROBE_FAILED_RUN_HALTED');
  assert.equal((await f.request()).error,'RUN_HALTED');
  assert.equal(f.calls.length,1);assert.equal(f.executor.status({agentName:'main'}).halted,true);
  assert.ok(!JSON.stringify(f.executor.database().prepare('SELECT result FROM requests').all()).includes('somebody-else'));
});
test('redirects, 401 and server rate limits halt without a target request',async t=>{
  for(const status of [302,401,429]) {
    const f=fixture(t,()=>{},async()=>({status,headers:{location:'https://evil.example/?token=hidden'},text:'secret'}));
    assert.equal((await f.request()).error,'AUTH_REDIRECT_OR_RATE_LIMIT_RUN_HALTED');assert.equal(f.calls.length,1);
  }
});
test('transport failure halts, exception text cannot leak',async t=>{
  const f=fixture(t,()=>{},async()=>{throw new Error('fixture-secret');});
  const r=await f.request();assert.equal(r.error,'TRANSPORT_FAILURE_RUN_HALTED');assert.ok(!JSON.stringify(r).includes('fixture-secret'));
});
test('budgets count probes and persist across executor recreation',async t=>{
  const f=fixture(t,c=>c.maxRequests=2);
  assert.equal((await f.request()).ok,true);f.executor.close();
  assert.equal((await f.request()).error,'REQUEST_BUDGET_EXHAUSTED');assert.equal(f.calls.length,2);
});
test('per-minute budget blocks before request',async t=>{
  const f=fixture(t,c=>c.requestsPerMinute=1);
  assert.equal((await f.request()).error,'RATE_LIMITED');assert.equal(f.calls.length,1);
});
test('concurrency bounded across agents sharing executor',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=fixture(t,c=>c.concurrency=1,async req=>{await gate;return {status:200,headers:{},text:req.url.pathname==='/me'?' {"id":"alice-id"}':'{}'};});
  const first=f.request();
  assert.equal((await f.request()).error,'CONCURRENCY_LIMIT_RETRY_LATER');
  release();assert.equal((await first).ok,true);assert.equal(f.executor.active,0);
});
test('kill switch changed during probe blocks target',async t=>{
  const f=fixture(t,()=>{},async(_req,{write,config})=>{write('config.json',{...config,enabled:false});return {status:200,headers:{},text:'{"id":"alice-id"}'};});
  assert.equal((await f.request()).error,'CONFIG_CHANGED_OR_DISABLED');assert.equal(f.calls.length,1);
});
test('expired credentials and unsafe file permissions fail closed',async t=>{
  const f=fixture(t);f.identity.alice.expiresAt='2000-01-01';f.write('identities.json',f.identity);
  assert.equal((await f.request()).error,'CREDENTIALS_EXPIRED');
  fs.chmodSync(path.join(f.dir,'identities.json'),0o644);
  assert.equal((await f.request()).error,'PRIVATE_FILE_REQUIRED');assert.equal(f.calls.length,0);
});
test('fixed GraphQL document; variables may vary but document cannot',async t=>{
  const f=fixture(t);
  assert.equal((await f.request({route:'gql',path_params:{},variables:{id:'456'}})).ok,true);
  const body=JSON.parse(f.calls[1].body);assert.equal(body.query,f.config.routes.gql.graphql.document);assert.deepEqual(body.variables,{id:'456'});
  assert.equal((await f.request({route:'gql',path_params:{},body:{query:'mutation { deleteEverything }'}})).error,'USE_GRAPHQL_VARIABLES');
});
test('oversized request rejected before probe',async t=>{
  const f=fixture(t);
  assert.equal((await f.request({route:'write',path_params:{},body:{s:'a'.repeat(70000)}})).error,'REQUEST_BODY_TOO_LARGE');assert.equal(f.calls.length,0);
});
test('non-JSON body withheld, authorization denial remains evidence',async t=>{
  const f=fixture(t,()=>{},async req=>({status:req.url.pathname==='/me'?200:403,headers:{},text:req.url.pathname==='/me'?' {"id":"alice-id"}':'<html>secret</html>'}));
  const r=await f.request();assert.equal(r.ok,true);assert.equal(r.status,403);assert.equal(r.body,'[NON_JSON_BODY_WITHHELD]');
});
test('public IPv4 filter blocks local, metadata, multicast and mapped forms',()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.1.1','192.168.1.1','100.64.0.1','0.0.0.0','224.0.0.1','198.18.0.1','::1','::ffff:127.0.0.1']) assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('8.8.8.8'),true);
});
test('scrub removes known secrets in keys, encoded strings and nested sensitive fields',()=>{
  const s='opaque_secret';const out=scrub({[s]:encodeURIComponent(s),x:Buffer.from(s).toString('base64'),nested:[{refreshToken:'unknown-token'}]},[s]);
  assert.ok(!JSON.stringify(out).includes(s));assert.equal(out.nested[0].refreshToken,'[REDACTED]');
});

test('credential revocation during probe blocks the target',async t=>{
  const f=fixture(t,()=>{},async(_req,{write,identity})=>{identity.alice.expiresAt='2000-01-01';write('identities.json',identity);return {status:200,headers:{},text:'{"id":"alice-id"}'};});
  assert.equal((await f.request()).error,'CREDENTIALS_EXPIRED');assert.equal(f.calls.length,1);
});
test('second named identity uses its own credentials and expected subject',async t=>{
  const f=fixture(t,c=>{c.identities.bob={...c.identities.alice};for(const r of Object.values(c.routes))r.identities.push('bob');},async req=>({status:200,headers:{},text:req.url.pathname==='/me'?JSON.stringify({id:req.headers.cookie==='sid=bob-fixture'?'bob-id':'alice-id'}):'{}'}));
  f.identity.bob={headers:{Cookie:'sid=bob-fixture'},expectedIdentity:'bob-id',expiresAt:f.config.expiresAt};f.write('identities.json',f.identity);
  assert.equal((await f.request({identity:'bob'})).ok,true);assert.equal(f.calls[1].headers.cookie,'sid=bob-fixture');
  assert.equal((await f.request()).ok,true);assert.equal(f.calls[3].headers.cookie,'sid=fixture-secret');
});
test('transport rejects private DNS answers before opening a socket',async t=>{
  const dns=require('node:dns').promises, https=require('node:https');
  t.mock.method(dns,'lookup',async()=>[{address:'169.254.169.254',family:4}]);
  const request=t.mock.method(https,'request',()=>{throw new Error('must not connect');});
  await assert.rejects(()=>require('../lib/tools/auth-http').transport({url:new URL('https://test.example/me'),method:'GET',headers:{},timeoutMs:100,maxBytes:4096}),/NON_PUBLIC_DESTINATION/);
  assert.equal(request.mock.callCount(),0);
});
test('transport pins public DNS, disables pooling and does not follow redirects',async t=>{
  const dns=require('node:dns').promises, https=require('node:https'), {EventEmitter}=require('node:events');
  t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);
  const request=t.mock.method(https,'request',(_url,opts,cb)=>{
    assert.equal(opts.agent,false);assert.equal(opts.headers['accept-encoding'],'identity');assert.ok(opts.signal);
    opts.lookup('test.example',{all:true},(e,addresses)=>{assert.equal(e,null);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);});
    opts.lookup('test.example',{},(e,address,family)=>{assert.equal(address,'8.8.8.8');assert.equal(family,4);});
    const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=302;res.headers={location:'https://evil.example'};cb(res);res.emit('end');});return req;
  });
  const r=await require('../lib/tools/auth-http').transport({url:new URL('https://test.example/me'),method:'GET',headers:{},timeoutMs:100,maxBytes:4096});
  assert.equal(r.status,302);assert.equal(request.mock.callCount(),1);
});
test('transport aborts an oversized response',async t=>{
  const dns=require('node:dns').promises, https=require('node:https'), {EventEmitter}=require('node:events');
  t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);
  t.mock.method(https,'request',(_url,_opts,cb)=>{
    const req=new EventEmitter();req.destroy=e=>req.emit('error',e);
    req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.headers={};res.statusCode=200;cb(res);res.emit('data',Buffer.alloc(4097));});return req;
  });
  await assert.rejects(()=>require('../lib/tools/auth-http').transport({url:new URL('https://test.example/me'),method:'GET',headers:{},timeoutMs:100,maxBytes:4096}),/RESPONSE_TOO_LARGE/);
});
test('transport DNS timeout is bounded',async t=>{
  t.mock.method(require('node:dns').promises,'lookup',()=>new Promise(()=>{}));
  await assert.rejects(()=>require('../lib/tools/auth-http').transport({url:new URL('https://test.example/me'),method:'GET',headers:{},timeoutMs:10,maxBytes:4096}),/DNS_TIMEOUT/);
});
test('tool schemas are available and auth_http_request is not concurrency-safe without loading MCP skills',()=>{
  const {tools}=require('../lib/tools/auth-http');
  assert.deepEqual(Object.keys(tools),['auth_http_status','auth_http_request']);
  assert.deepEqual(tools.auth_http_request.parameters.required,['identity','route']);
  assert.equal(require('../lib/tool-concurrency').isConcurrencySafe('auth_http_request'),false);
  const source=fs.readFileSync(path.join(__dirname,'../lib/sdk-chat.js'),'utf8');
  assert.ok(source.includes("name.startsWith('auth_http_')"));
  assert.ok(source.includes('auth_http: /^auth_http_/'));
});

test('HTTP 200 login HTML and GraphQL authentication errors halt the run',async t=>{
  for(const text of ['<html>Sign in</html>','{"errors":[{"extensions":{"code":"UNAUTHENTICATED"}}]}']) {
    const f=fixture(t,()=>{},async req=>({status:200,headers:{},text:req.url.pathname==='/me'?' {"id":"alice-id"}':text}));
    assert.equal((await f.request()).error,'AUTH_ERROR_OR_UNEXPECTED_BODY_RUN_HALTED');assert.equal(f.calls.length,2);
  }
});
test('request evidence retains safe reproducer fields and strips credentials',async t=>{
  const f=fixture(t);
  const r=await f.request({route:'write',path_params:{},body:{object:'123',password:'never-log',echo:'fixture-secret'}});
  assert.equal(r.ok,true);assert.equal(r.request.method,'POST');assert.equal(r.request.body.object,'123');
  assert.equal(r.request.body.password,'[REDACTED]');assert.equal(r.request.body.echo,'[REDACTED]');
  assert.ok(!JSON.stringify(f.executor.database().prepare('SELECT result FROM requests').all()).includes('never-log'));
});
test('large redacted response is explicitly truncated',async t=>{
  const f=fixture(t,()=>{},async req=>({status:200,headers:{},text:req.url.pathname==='/me'?' {"id":"alice-id"}':JSON.stringify({data:'x'.repeat(30000)})}));
  const r=await f.request();assert.equal(r.bodyTruncated,true);assert.equal(r.body.length,24000);
});
