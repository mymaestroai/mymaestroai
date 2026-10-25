'use strict';
// Per-agent tool policy: role defaults, path and shell classification, tool classification across
// paths, decisions, allowances ("approve this kind for 1 hour"), denial text.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const tp = require('../lib/tool-policy');

const HUB = tp.HUB_ROOT;
const worker = { name: 'haiku', category: 'worker' };
// Team membership is data: an agent is on the medical team when its own folder grants include medical/.
const head = { name: 'gp', category: 'primary', policy: { roots: [path.join(tp.HUB_HOME, 'medical')] } };
const lead = { name: 'maestro', category: 'primary', lead: true };
const trader = { name: 'trader', category: 'specialist' };
const isWallet = (n) => n === 'trader';
const cwd = (a) => path.join(HUB, 'workspaces', a.name);

test('roles and defaults: worker denies, head asks, lead asks incl. destroy, wallet agent gets the firewall', () => {
  assert.strictEqual(tp.roleOf(worker), 'worker');
  assert.strictEqual(tp.roleOf(head), 'head');
  assert.strictEqual(tp.roleOf(lead), 'lead');
  assert.strictEqual(tp.roleOf(trader, { isWalletAgent: isWallet }), 'wallet');
  assert.deepStrictEqual(tp.policyFor(worker).rules, { read_outside: 'allow', web: 'allow', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny', money: 'deny' });
  assert.deepStrictEqual(tp.policyFor(head).rules, { read_outside: 'allow', web: 'allow', write_outside: 'ask', send: 'ask', admin: 'ask', destroy: 'deny', money: 'deny' });
  assert.deepStrictEqual(tp.policyFor(lead).rules, { read_outside: 'allow', web: 'allow', write_outside: 'ask', send: 'ask', admin: 'ask', destroy: 'ask', money: 'deny' });
  const member = { name: 'sam_doc', category: 'primary', owner: 'u_sam' };
  assert.strictEqual(tp.roleOf(member, { isMemberOwned: () => true }), 'member');
  assert.deepStrictEqual(tp.policyFor(member, { isMemberOwned: () => true }).rules, { read_outside: 'deny', web: 'deny', write_outside: 'deny', send: 'deny', admin: 'deny', destroy: 'deny', money: 'deny' });
  assert.strictEqual(tp.policyFor(trader, { isWalletAgent: isWallet }).rules.money, 'firewall');
  // overrides from agents.json, only valid values
  const p = tp.policyFor({ ...worker, policy: { overrides: { send: 'ask', destroy: 'bogus' }, roots: ['~/scratch'] } });
  assert.strictEqual(p.rules.send, 'ask');
  assert.strictEqual(p.rules.destroy, 'deny');
  assert.ok(p.roots.includes(path.join(os.homedir(), 'scratch')));
});

test('default roots: own workspace, share, tmp; team folders for team members; hub tree for the lead', () => {
  const r = tp.policyFor(head).roots;
  assert.ok(r.includes(path.join(HUB, 'workspaces', 'gp')));
  assert.ok(r.includes(path.join(tp.HUB_HOME, 'medical')), 'the agent\'s own folder grant');
  assert.ok(!r.includes(path.join(tp.HUB_HOME, 'legal')));
  assert.ok(!tp.defaultRoots({ name: 'counsel', category: 'primary' }).includes(path.join(tp.HUB_HOME, 'legal')), 'never by name');
  assert.strictEqual(tp.teamFolderOf(head), 'medical');
  assert.strictEqual(tp.teamFolderOf({ name: 'counsel', policy: { roots: [path.join(tp.HUB_HOME, 'legal')] } }), 'legal');
  assert.strictEqual(tp.teamFolderOf({ name: 'gp' }), null);
  assert.ok(tp.defaultRoots(lead).includes(HUB));
  assert.ok(!tp.defaultRoots(worker).includes(HUB));
});

test('classifyPath: inside roots, outside, and admin (hub data, .env, other workspaces, system dirs)', () => {
  const roots = tp.policyFor(head).roots;
  const opts = { roots, agentName: 'gp' };
  assert.strictEqual(tp.classifyPath(path.join(HUB, 'workspaces', 'gp', 'notes.md'), opts), 'write_inside');
  assert.strictEqual(tp.classifyPath(path.join(tp.HUB_HOME, 'medical', 'patients', 'pat.md'), opts), 'write_inside');
  assert.strictEqual(tp.classifyPath('/tmp/x', opts), 'write_inside');
  assert.strictEqual(tp.classifyPath(path.join(os.homedir(), 'Desktop', 'x'), opts), 'write_outside');
  assert.strictEqual(tp.classifyPath(path.join(HUB, 'lib', 'x.js'), opts), 'write_outside');
  assert.strictEqual(tp.classifyPath(path.join(HUB, 'data', 'agents.json'), opts), 'admin');
  assert.strictEqual(tp.classifyPath(path.join(HUB, '.env'), opts), 'admin');
  assert.strictEqual(tp.classifyPath(path.join(HUB, 'workspaces', 'counsel', 'SOUL.md'), opts), 'admin');
  assert.strictEqual(tp.classifyPath('/etc/hosts', opts), 'admin');
  // the lead may edit hub code, but data/ and other workspaces are still admin
  const lr = tp.policyFor(lead).roots;
  assert.strictEqual(tp.classifyPath(path.join(HUB, 'lib', 'x.js'), { roots: lr, agentName: 'maestro' }), 'write_inside');
  assert.strictEqual(tp.classifyPath(path.join(HUB, 'data', 'agents.json'), { roots: lr, agentName: 'maestro' }), 'admin');
  assert.strictEqual(tp.classifyPath(path.join(HUB, 'workspaces', 'gp', 'SOUL.md'), { roots: lr, agentName: 'maestro' }), 'admin');
});

test('classifyCommand: reads, inside writes, outside writes, sends, destroys', () => {
  const roots = tp.policyFor(head).roots;
  const o = { cwd: cwd(head), roots, agentName: 'gp' };
  const c = (cmd) => tp.classifyCommand(cmd, o).cls;
  assert.strictEqual(c('ls -la && grep -rn foo .'), 'read');
  assert.strictEqual(c('cat /etc/hosts | head'), 'read_outside', 'a read outside the roots is its own class (allowed for admin-side roles, denied for members)');
  const PAT = path.join(tp.HUB_HOME, 'medical', 'patients');   // the hub home, wherever the install sits (CI clones elsewhere)
  assert.strictEqual(c(`cat "${PAT}/pat.md"`), 'read', 'inside a root');
  assert.strictEqual(c('cat ' + path.join(HUB, '.env')), 'admin', 'secrets are admin even to read');
  assert.strictEqual(c('sqlite3 ' + path.join(HUB, 'data', 'memory.db') + ' .tables'), 'admin', 'other agents\' memory is not readable raw');
  assert.strictEqual(c('echo hi > notes.txt'), 'write_inside');
  assert.strictEqual(c(`mkdir -p "${PAT}/x" && cp a.pdf "${PAT}/x/"`), 'write_inside');
  assert.strictEqual(c('cp report.md ~/Desktop/report.md'), 'write_outside');
  assert.strictEqual(c('echo x >> ' + path.join(HUB, 'data', 'agents.json')), 'admin');
  assert.strictEqual(c('sed -i s/a/b/ /etc/ssh/sshd_config'), 'admin');
  assert.strictEqual(c('gog gmail send --to lee@example.com --subject hi --body-file b.txt'), 'send');
  assert.strictEqual(c('git add -A && git commit -m x && git push origin main'), 'send');
  assert.strictEqual(c('curl -s -X POST https://api.example.com/v1 -d @payload.json'), 'send');
  assert.strictEqual(c('curl -s -X POST http://127.0.0.1:9999/api/chat -d @t.json'), 'write_inside', 'local hub API is inside');
  assert.strictEqual(c('curl -s https://example.com/page'), 'read', 'GET is a read (web class is for WebFetch/WebSearch)');
  assert.strictEqual(c('scp report.pdf owner@laptop:/tmp/'), 'send');
  assert.strictEqual(c('rsync -av ./out/ backup:/srv/'), 'send');
  assert.strictEqual(c('rm -rf /tmp/build'), 'destroy');
  assert.strictEqual(c('rm notes.txt'), 'write_inside', 'plain rm inside roots is an inside write');
  assert.strictEqual(c('rm ~/Desktop/x.txt'), 'write_outside');
  assert.strictEqual(c('systemctl --user restart agent-hub-v5'), 'destroy');
  assert.strictEqual(c('pkill -f node'), 'destroy');
  assert.strictEqual(c('git reset --hard HEAD~1'), 'destroy');
  assert.strictEqual(c('git push --force origin main'), 'destroy');
  assert.strictEqual(c('curl -s -X POST http://127.0.0.1:9999/api/restart'), 'destroy', 'restarting the hub is destructive even though local');
  assert.strictEqual(c('sudo reboot'), 'destroy');
  // the worst segment wins
  assert.strictEqual(c('ls && rm -rf build'), 'destroy');
});

test('classifyCommand: regex literals, comparisons and quoted text are not writes (the false positives that parked the lead)', () => {
  const roots = tp.policyFor(head).roots;
  const o = { cwd: cwd(head), roots, agentName: 'gp' };
  const c0 = (cmd) => tp.classifyCommand(cmd, o).cls;
  const c = (cmd) => (['read', 'read_outside'].includes(c0(cmd)) ? 'read' : c0(cmd));   // reads of any kind count as reads here
  assert.strictEqual(c(`S=$(grep -n 'class="main-header"' index.html | head -1 | cut -d: -f1); E=$(awk -v s=$S 'NR>s && /class="messages"|id="messages"/{print NR; exit}' index.html); sed -n "$S,$E p" index.html`), 'read');
  assert.strictEqual(c(`grep -o '<\\(button\\|select\\)[^>]*>' index.html | sed 's/style="[^"]*"//g'`), 'read');
  assert.strictEqual(c(`awk '$3 > 100 {print $1}' /var/log/syslog`), 'read');
  assert.strictEqual(c(`echo "a > b" && echo 'x > /etc/y'`), 'read', 'redirections inside quotes are text');
  assert.strictEqual(c(`node --test test/x.test.js 2>&1 | grep -E "^# (pass|fail)"`), 'read', 'fd duplication is not a file');
  assert.strictEqual(c(`cat /etc/hosts > /dev/null`), 'read');   // c() folds read_outside into read below
  assert.strictEqual(c(`python3 - <<'EOF'\nimport re\nif x > 1: print('/class=/')\nEOF`), 'read');
  assert.strictEqual(c(`# cp /etc/passwd ~/Desktop/`), 'read', 'comments are not commands');
  // true positives still hold with argument-based extraction
  assert.strictEqual(c(`echo x > /etc/motd`), 'admin');
  assert.strictEqual(c(`cat a | tee ~/Desktop/out.txt`), 'write_outside');
  assert.strictEqual(c(`cp -r ./build ~/Desktop/site`), 'write_outside');
  assert.strictEqual(c(`chmod 600 ~/Desktop/secret`), 'write_outside');
  assert.strictEqual(c(`sed -i 's/a/b/' "${path.join(tp.HUB_HOME, 'medical', 'patients', 'pat.md')}"`), 'write_inside');
  assert.strictEqual(c(`sed -i 's/a/b/' /etc/ssh/sshd_config`), 'admin');
  assert.strictEqual(c(`tar -xzf x.tgz -C /opt/stuff`), 'write_outside');
  assert.strictEqual(c(`git clone https://example.com/r.git ~/Desktop/r`), 'write_outside');
  assert.strictEqual(c(`git checkout -b feature`), 'write_inside');
});

test('classifyTool: SDK built-ins, hub tools, run_job re-check, comms, wallet, skill tools', () => {
  const pol = tp.policyFor(head);
  const t = (tool, input) => tp.classifyTool({ tool, input, agentName: 'gp', policy: pol, cwd: cwd(head) });
  assert.strictEqual(t('Read', { file_path: '/etc/hosts' }).cls, 'read_outside');
  assert.strictEqual(t('Read', { file_path: path.join(tp.HUB_HOME, 'medical/patients/pat.md') }).cls, 'read');
  assert.strictEqual(t('Read', { file_path: path.join(HUB, 'data', 'users.json') }).cls, 'admin');
  assert.strictEqual(t('Grep', { pattern: 'x' }).cls, 'read');
  assert.strictEqual(t('WebFetch', { url: 'https://x' }).cls, 'web');
  assert.strictEqual(t('WebSearch', { query: 'x' }).cls, 'web');
  assert.strictEqual(t('Write', { file_path: 'plan.md' }).cls, 'write_inside', 'relative path resolves against the workspace');
  assert.strictEqual(t('Write', { file_path: path.join(os.homedir(), 'Desktop/plan.md') }).cls, 'write_outside');
  assert.strictEqual(t('Edit', { file_path: path.join(HUB, 'workspaces', 'counsel', 'SOUL.md') }).cls, 'admin');
  assert.strictEqual(t('Bash', { command: 'gog gmail send --to a@b.c' }).cls, 'send');
  assert.strictEqual(t('mcp__agent-hub__consult_agent', { agent: 'labs', prompt: 'x' }).cls, 'delegate');
  assert.strictEqual(t('consult_agent', { agent: 'labs', prompt: 'x' }).cls, 'delegate');
  assert.strictEqual(t('read_memory', {}).cls, 'read');
  assert.strictEqual(t('append_memory', { content: 'x' }).cls, 'write_inside');
  assert.strictEqual(t('create_agent', { name: 'x' }).cls, 'admin');
  assert.strictEqual(t('run_job', { name: 'j', command: 'node backtest.js > out.log' }).cls, 'delegate');
  assert.strictEqual(t('run_job', { name: 'j', command: 'rm -rf ~/agent-hub' }).cls, 'destroy', 'job commands are re-checked');
  assert.strictEqual(t('run_job', { name: 'j', command: 'git push origin main' }).cls, 'send');
  const cs = t('comms_send', { channel: 'telegram', to: 'owner', text: 'hello' });
  assert.strictEqual(cs.cls, 'send'); assert.strictEqual(cs.destKey, 'telegram:owner');
  assert.strictEqual(t('wallet_swap', { amount: '1' }).cls, 'money');
  assert.strictEqual(t('hl_order', {}).cls, 'money');
  assert.strictEqual(t('slack__slack_list_channels', {}).cls, 'read_outside', 'the admin\'s external accounts');
  assert.strictEqual(t('slack__slack_send_message', { channel_id: 'C1', text: 'hi' }).cls, 'send');
  assert.strictEqual(t('github__create_pull_request', { owner: 'o' }).cls, 'send');
  assert.strictEqual(t('google_workspace__edit_google_doc', { documentId: 'd' }).cls, 'write_outside');
  assert.strictEqual(t('google_workspace__search_drive_files', { query: 'q' }).cls, 'read_outside');
});

test('decide: always-allowed classes, role rules, wallet firewall, allowances, caps', () => {
  const d = (agent, tool, input, extra = {}) => tp.decide({ agent, tool, input, cwd: cwd(agent), isWalletAgent: isWallet, ...extra });
  assert.strictEqual(d(worker, 'Read', { file_path: '/x' }).decision, 'allow');
  const memberAgent = { name: 'sam_doc', category: 'primary', owner: 'u_sam' };
  const asMember = { isMemberOwned: () => true };
  assert.strictEqual(d(memberAgent, 'Read', { file_path: path.join(tp.HUB_HOME, 'users/u_sam/medical/patients/x.md') }, asMember).decision, 'allow', 'own folder');
  assert.strictEqual(d(memberAgent, 'Read', { file_path: path.join(tp.HUB_HOME, 'medical/patients/pat.md') }, asMember).decision, 'deny', 'the admin\'s patient files');
  assert.strictEqual(d(memberAgent, 'Bash', { command: 'cat ' + path.join(tp.HUB_HOME, 'medical/patients/pat.md') }, asMember).decision, 'deny');
  assert.strictEqual(d(memberAgent, 'Bash', { command: 'cat ' + path.join(HUB, '.env') }, asMember).decision, 'deny');
  assert.strictEqual(d(memberAgent, 'WebFetch', { url: 'https://example.com' }, asMember).decision, 'deny', 'web is a grant, off by default');
  assert.strictEqual(d(memberAgent, 'slack__slack_list_channels', {}, asMember).decision, 'deny');
  assert.strictEqual(d(memberAgent, 'consult_agent', { agent: 'sam_labs', prompt: 'x' }, asMember).decision, 'allow');
  assert.strictEqual(d(memberAgent, 'read_shared_memory', {}, asMember).decision, 'allow', 'their own pool');
  assert.strictEqual(d({ ...memberAgent, policy: { overrides: { web: 'allow' } } }, 'WebFetch', { url: 'https://example.com' }, asMember).decision, 'allow', 'a grant');
  assert.strictEqual(d(lead, 'Bash', { command: 'cat ' + path.join(HUB, '.env') }).decision, 'ask', 'even the lead asks to read secrets');
  assert.strictEqual(d(worker, 'consult_agent', { agent: 'x', prompt: 'y' }).decision, 'allow');
  assert.strictEqual(d(worker, 'Bash', { command: 'gog gmail send --to a@b.c' }).decision, 'deny');
  assert.strictEqual(d(head, 'Bash', { command: 'gog gmail send --to a@b.c' }).decision, 'ask');
  assert.strictEqual(d(head, 'Bash', { command: 'rm -rf /tmp/x' }).decision, 'deny');
  assert.strictEqual(d(lead, 'Bash', { command: 'systemctl --user restart agent-hub-v5' }).decision, 'ask');
  assert.strictEqual(d(lead, 'Edit', { file_path: path.join(HUB, 'lib', 'x.js') }).decision, 'allow', 'lead edits hub code freely');
  assert.strictEqual(d(lead, 'Bash', { command: 'git push origin main' }).decision, 'ask');
  assert.strictEqual(d(trader, 'wallet_swap', {}).decision, 'allow');
  assert.strictEqual(d(trader, 'wallet_swap', {}).reason, 'wallet firewall governs');
  assert.strictEqual(d(worker, 'wallet_swap', {}).decision, 'deny');
  assert.strictEqual(d(trader, 'Bash', { command: 'git push' }).decision, 'deny');
  // an allowance turns ask into allow for the same destination only
  const al = tp.createAllowances();
  const first = d(head, 'comms_send', { channel: 'telegram', to: 'owner', text: 'a' }, { allowances: al });
  assert.strictEqual(first.decision, 'ask');
  al.add(first.allowKey);
  assert.strictEqual(d(head, 'comms_send', { channel: 'telegram', to: 'owner', text: 'b' }, { allowances: al }).decision, 'allow');
  assert.strictEqual(d(head, 'comms_send', { channel: 'telegram', to: 'sam', text: 'b' }, { allowances: al }).decision, 'ask', 'different recipient asks again');
  // for every other class one approval covers the kind of action for that agent, whatever the folder or command
  const rmA = d(lead, 'Bash', { command: 'rm -rf /tmp/hubcopy' }, { allowances: al });
  assert.strictEqual(rmA.decision, 'ask'); assert.strictEqual(rmA.allowKey, 'maestro|destroy');
  al.add(rmA.allowKey);
  assert.strictEqual(d(lead, 'Bash', { command: 'pkill -f hubcopy; rm -rf /var/tmp/other' }, { allowances: al }).decision, 'allow', 'another destructive command in another place is covered');
  assert.strictEqual(d(lead, 'Bash', { command: 'git push origin main' }, { allowances: al }).decision, 'ask', 'a different class still asks');
  const wo = d(head, 'Write', { file_path: path.join(tp.HUB_HOME, 'agent-hub-5.1.0/x.js') }, { allowances: al });
  assert.strictEqual(wo.decision, 'ask'); assert.strictEqual(wo.allowKey, 'gp|write_outside');
  al.add(wo.allowKey);
  assert.strictEqual(d(head, 'Write', { file_path: path.join(os.homedir(), 'notes/x.txt') }, { allowances: al }).decision, 'allow', 'write_outside covered in any folder for the hour');
  assert.strictEqual(d(head, 'Write', { file_path: '/etc/hosts.txt' }, { allowances: al }).decision, 'ask', 'system paths are the admin class: a separate approval');
  assert.strictEqual(d(head, 'comms_send', { channel: 'telegram', to: 'sam', text: 'b' }, { allowances: al }).decision, 'ask', 'send stays per recipient');
  // over a cap, an allowed decided action becomes ask
  const permissive = { ...head, policy: { overrides: { send: 'allow' } } };
  assert.strictEqual(d(permissive, 'comms_send', { channel: 'telegram', to: 'owner', text: 'a' }).decision, 'allow');
  assert.strictEqual(d(permissive, 'comms_send', { channel: 'telegram', to: 'owner', text: 'a' }, { capped: true }).decision, 'ask');
});

test('allowances expire; denial text names the class and what to do', () => {
  let t = 1000;
  const al = tp.createAllowances({ now: () => t });
  al.add('k', 100);
  assert.ok(al.has('k'));
  t += 101;
  assert.ok(!al.has('k'));
  assert.strictEqual(al.list().length, 0);
  const dec = { decision: 'deny', cls: 'send', role: 'worker', reason: 'worker policy: send = deny', summary: 'gog gmail send' };
  assert.match(tp.denialText(dec), /^\[DENIED BY POLICY\] sending anything off this machine/);
  assert.match(tp.denialText(dec, { by: 'owner' }), /^\[DENIED BY OWNER\]/);
  assert.match(tp.denialText(dec, { by: 'timeout' }), /^\[NOT APPROVED\]/);
});

test('key files by name are secrets for everyone: a bot\'s agent-key, private keys, pem/secret files, ssh ids; ordinary files are not', () => {
  const ws = path.join(HUB, 'workspaces', 'trader', 'bots', 'hl-exec');
  for (const f of ['agent-key', 'private.key', 'signing-key.txt', 'api_key', 'server.pem', 'token.secret', 'id_ed25519', 'id_rsa.pub'.replace('.pub', '')]) assert.strictEqual(tp.isSensitiveRead(path.join(ws, f)), true, f);
  for (const f of ['hl.js', 'config.json', 'orders.jsonl', 'keyboard.md', 'monkey.js', 'README.md']) assert.strictEqual(tp.isSensitiveRead(path.join(ws, f)), false, f);
  // another agent reading trader's key file is an admin action (ask for heads, deny for workers); trader reading its own is a plain read
  assert.strictEqual(tp.classifyReadPath(path.join(ws, 'agent-key'), { roots: [path.join(HUB, 'workspaces', 'gp')], agentName: 'gp' }), 'admin');
  assert.strictEqual(tp.decide({ agent: worker, tool: 'Read', input: { file_path: path.join(ws, 'agent-key') }, cwd: cwd(worker) }).decision, 'deny');
  assert.strictEqual(tp.decide({ agent: { name: 'trader', category: 'primary' }, tool: 'Read', input: { file_path: path.join(ws, 'agent-key') }, cwd: path.join(HUB, 'workspaces', 'trader'), isWalletAgent: isWallet }).cls, 'admin', 'even its owner: the hub treats key files as admin reads (the policy only classifies; trader\'s own script reads the file itself)');
});

test('the hub\'s hands under their MCP names classify exactly like the client built-ins; RestartHub is admin (review F04/F50)', () => {
  const pol = tp.policyFor(worker);
  const same = (tool, input) => {
    const a = tp.classifyTool({ tool, input, agentName: 'haiku', policy: pol });
    const b = tp.classifyTool({ tool: `mcp__hub__${tool}`, input, agentName: 'haiku', policy: pol });
    assert.strictEqual(b.cls, a.cls, tool);
    return a.cls;
  };
  assert.strictEqual(same('Bash', { command: `rm -rf ${HUB}` }), 'destroy');
  assert.strictEqual(same('Write', { file_path: path.join(HUB, 'lib', 'x.js'), content: 'x' }), 'write_outside');
  assert.strictEqual(same('Read', { file_path: path.join(HUB, '.env') }), 'admin');
  assert.strictEqual(same('WebFetch', { url: 'http://10.0.0.1/' }), 'web');
  assert.strictEqual(same('Edit', { file_path: path.join(HUB, 'workspaces', 'haiku', 'notes.md'), old_string: 'a', new_string: 'b' }), 'write_inside');
  assert.strictEqual(same('Glob', { pattern: '**/*.js' }), 'read');
  for (const t of ['RestartHub', 'mcp__agent-hub__RestartHub']) assert.strictEqual(tp.classifyTool({ tool: t, input: {}, agentName: 'haiku' }).cls, 'admin', t);
  assert.strictEqual(tp.decide({ agent: worker, tool: 'mcp__hub__Bash', input: { command: `rm -rf ${HUB}` }, cwd: cwd(worker) }).decision, 'deny');
  assert.strictEqual(tp.decide({ agent: worker, tool: 'RestartHub', input: {}, cwd: cwd(worker) }).decision, 'deny');
  // other MCP servers keep their own classification (a skill or connector tool is not a built-in)
  assert.strictEqual(tp.classifyTool({ tool: 'mcp__agent-hub__read_memory', input: {}, agentName: 'haiku' }).cls, 'read');
});

test('root: sudo/doas/pkexec/su make a command admin (or worse) and flag it; only the lead may run them (review H01/F24)', () => {
  const cc = (cmd) => tp.classifyCommand(cmd, { cwd: HUB });
  assert.strictEqual(cc('sudo apt install zstd').cls, 'admin');
  assert.strictEqual(cc('sudo apt install zstd').sudo, true);
  assert.strictEqual(cc('sudo -n systemctl restart cloudflared').cls, 'admin');
  assert.strictEqual(cc('sudo rm -rf /etc/cloudflared').cls, 'destroy', 'the inner command can make it worse');
  assert.strictEqual(cc('sudo rm -rf /etc/cloudflared').sudo, true);
  assert.strictEqual(cc('cat x | sudo tee /etc/hosts').sudo, true, 'a later segment counts');
  assert.strictEqual(cc('FOO=1 sudo -u root -E ls /root').sudo, true, 'env prefixes and flags are skipped');
  assert.strictEqual(cc('su -c "id"').cls, 'admin');
  assert.strictEqual(cc('su -c "id"').sudo, true);
  assert.strictEqual(cc('pkexec cat /etc/shadow').sudo, true);
  assert.strictEqual(cc('echo sudo is a word').sudo, undefined, 'the word as an argument is not escalation');
  assert.strictEqual(cc('grep -n "sudo " README.md').sudo, undefined);
  assert.strictEqual(cc('ls -la').sudo, undefined);
  const dec = (agent, cmd, extra = {}) => tp.decide({ agent, tool: 'Bash', input: { command: cmd }, cwd: cwd(agent), ...extra });
  assert.strictEqual(dec(lead, 'sudo -n ls /root').decision, 'ask', 'lead: the admin rule (allowed while cards are off; a card when the owner lists sudo)');
  assert.strictEqual(dec(lead, 'sudo -n ls /root').detail.sudo, true);
  for (const a of [head, worker, trader]) assert.strictEqual(dec(a, 'sudo -n ls /root').decision, 'deny', a.name);
  assert.match(dec(head, 'sudo -n ls /root').reason, /reserved for the lead agent/);
  const member = { name: 'sam_doc', category: 'primary', owner: 'u_sam' };
  assert.strictEqual(dec(member, 'sudo id', { isMemberOwned: () => true }).decision, 'deny');
  assert.match(tp.denialText(dec(head, 'sudo -n ls /root')), /running a command as root \(sudo\)/);
  // run_job carries the same flag and rule, under its MCP name too
  assert.strictEqual(tp.decide({ agent: head, tool: 'run_job', input: { name: 'x', command: 'sudo reboot' }, cwd: cwd(head) }).decision, 'deny');
  assert.strictEqual(tp.decide({ agent: lead, tool: 'mcp__agent-hub__run_job', input: { name: 'x', command: 'sudo -n apt update' }, cwd: cwd(lead) }).detail.sudo, true);
});

test('reboot words: reading the reboot-required file is not a reboot; real reboots, shutdowns and their systemd targets still are (2026-10-24)', () => {
  const tpr = require('../lib/tool-policy');
  const cls = (c) => tpr.classifyCommand(c, { cwd: '/tmp', roots: ['/tmp'], agentName: 'reviewer' }).cls;
  for (const c of ['ls /var/run/reboot-required', 'ls /var/run/reboot-required 2>&1; systemctl is-enabled unattended-upgrades', 'test -e /var/run/reboot-required && echo restart-needed',
    'cat /var/run/reboot-required.pkgs', 'cat /proc/sys/kernel/sysrq', 'git init', 'git init 0', 'npm init -y']) assert.notStrictEqual(cls(c), 'destroy', c);
  for (const c of ['reboot', 'sudo reboot', 'sudo shutdown now', 'systemctl reboot', 'shutdown -r now', '/sbin/shutdown -h now', 'poweroff', 'halt -p', 'nohup reboot &',
    'echo bye; reboot', 'reboot&&echo done', '(reboot)', 'systemctl isolate reboot.target', 'systemctl start poweroff.target', 'systemctl start halt.target', 'systemctl isolate poweroff.target', 'echo x; init 6', 'exec init 6', 'nohup init 6 &', 'x=1 init 6',
    'poweroff --force', 'systemctl soft-reboot', 'systemctl kexec', 'kexec -e', 'init 6', 'telinit 0', 'sudo init 0', '/sbin/init 6',
    // classification strings only, never run: systemd unit actions and the D-Bus call reboot the machine too
    'systemd-run --property=SuccessAction=reboot-force /usr/bin/true', 'systemd-run -p FailureAction=poweroff-immediate false',
    'busctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager Reboot b false', 'echo b > /proc/sysrq-trigger']) assert.strictEqual(cls(c), 'destroy', c);
});
