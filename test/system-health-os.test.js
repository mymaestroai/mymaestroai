'use strict';
// Operating-system updates and the Node.js watch in the system health check: the probe (fake exec / exists / stat) and the judging (fake probes, fake clock).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProbes } = require('../lib/system-health/probes');
const { createSystemHealth } = require('../lib/system-health');

const HOUR = 3600000, DAY = 86400000;
// real `LC_ALL=C apt-get -s upgrade` output captured on an Ubuntu 24.04 machine (261 upgrades, none from -security)
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'system-health-apt-get-s-upgrade.txt'), 'utf8');
const APT_CHECK = '/usr/lib/update-notifier/apt-check';
const STAMP = '/var/lib/apt/periodic/update-success-stamp';
const LISTS = '/var/lib/apt/lists';

// ── probe harness: commands answer from a table; anything else "can't start" (code null) ──
function probe({ platform = 'linux', cmds = {}, files = {}, mtimes = {}, calls = [] } = {}) {
  const exec = async (file, args, o) => {
    calls.push({ file, args, o });
    const r = cmds[`${file} ${args.join(' ')}`.trim()];
    if (r === undefined) return { stdout: '', stderr: 'spawn ENOENT', code: null, timedOut: false };
    if (r instanceof Error) throw r;
    return { stdout: '', stderr: '', code: 0, timedOut: false, ...r };
  };
  const exists = async (p) => p in files;
  const stat = async (p) => { if (p in mtimes) return { mtimeMs: mtimes[p] }; throw new Error('ENOENT'); };
  const readFile = async (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); };
  return createProbes({ platform, exec, exists, stat, readFile }).osUpdates;
}
const APT_GET = 'apt-get -s upgrade';

test('apt-check: the numbers on stderr (as on a real Ubuntu) and on stdout; kind apt; no arguments', async () => {
  const calls = [];
  const a = await probe({ calls, files: { [APT_CHECK]: '' }, cmds: { [APT_CHECK]: { stderr: '261;0' } } })();
  assert.strictEqual(a.kind, 'apt'); assert.strictEqual(a.pending, 261); assert.strictEqual(a.security, 0); assert.strictEqual(a.error, null);
  assert.deepStrictEqual(calls[0].args, []);
  const b = await probe({ files: { [APT_CHECK]: '' }, cmds: { [APT_CHECK]: { stdout: '12;3\n' } } })();
  assert.strictEqual(b.pending, 12); assert.strictEqual(b.security, 3);
  assert.ok(!calls.some(c => c.file === 'apt-get'), 'apt-get is not used when apt-check is there');
});

test('apt-check that fails or prints nothing readable: null numbers, an error, kind stays apt', async () => {
  const a = await probe({ files: { [APT_CHECK]: '' }, cmds: { [APT_CHECK]: { stderr: 'boom', code: 1 } } })();
  assert.strictEqual(a.kind, 'apt'); assert.strictEqual(a.pending, null); assert.strictEqual(a.security, null); assert.ok(a.error);
});

test('apt-get -s upgrade from the real capture: 261 pending, 0 security; runs with LC_ALL=C', async () => {
  const calls = [];
  const r = await probe({ calls, cmds: { [APT_GET]: { stdout: FIXTURE } } })();
  assert.strictEqual(r.kind, 'apt'); assert.strictEqual(r.pending, 261); assert.strictEqual(r.security, 0);
  assert.deepStrictEqual(calls[0].o.env, { LC_ALL: 'C' });
});

test('apt-get -s upgrade: lines whose origin has -security count as security', async () => {
  let n = 0;
  const text = FIXTURE.split('\n').map((l) => (l.startsWith('Inst ') && n++ < 2 ? l.replace('noble-updates', 'noble-security') : l)).join('\n');
  assert.notStrictEqual(text, FIXTURE);
  const r = await probe({ cmds: { [APT_GET]: { stdout: text } } })();
  assert.strictEqual(r.pending, 261); assert.strictEqual(r.security, 2);
  // a package named "...-security" with another origin is not a security update
  const t2 = await probe({ cmds: { [APT_GET]: { stdout: 'Inst foo-security [1] (2 Ubuntu:24.04/noble-updates [amd64])\nConf foo-security (2 x)\n' } } })();
  assert.strictEqual(t2.pending, 1); assert.strictEqual(t2.security, 0);
});

test('apt-get that fails: null numbers and an error', async () => {
  const r = await probe({ cmds: { [APT_GET]: { stderr: 'E: locked', code: 100 } } })();
  assert.strictEqual(r.kind, 'apt'); assert.strictEqual(r.pending, null); assert.ok(r.error);
});

test('apt lists time: the success stamp first, then the lists folder, else null', async () => {
  const cmds = { [APT_GET]: { stdout: FIXTURE } };
  assert.strictEqual((await probe({ cmds, mtimes: { [STAMP]: 1000, [LISTS]: 5000 } })()).listsRefreshedAt, 1000);
  assert.strictEqual((await probe({ cmds, mtimes: { [LISTS]: 5000 } })()).listsRefreshedAt, 5000);
  assert.strictEqual((await probe({ cmds })()).listsRefreshedAt, null);
});

test('apt restart: reboot-required with its .pkgs (deduplicated, at most 20); a missing file means false', async () => {
  const cmds = { [APT_GET]: { stdout: FIXTURE } };
  const pk = ['linux-image-6.8', 'linux-image-6.8', 'libc6', ...Array.from({ length: 30 }, (_, i) => `pkg${i}`)].join('\n') + '\n';
  const yes = await probe({ cmds, files: { '/var/run/reboot-required': '', '/var/run/reboot-required.pkgs': pk } })();
  assert.strictEqual(yes.restartRequired, true);
  assert.strictEqual(yes.restartPkgs.length, 20);
  assert.deepStrictEqual(yes.restartPkgs.slice(0, 3), ['linux-image-6.8', 'libc6', 'pkg0']);
  const bare = await probe({ cmds, files: { '/var/run/reboot-required': '' } })();
  assert.strictEqual(bare.restartRequired, true); assert.deepStrictEqual(bare.restartPkgs, []);
  const no = await probe({ cmds })();
  assert.strictEqual(no.restartRequired, false);
});

const DNF_LIST = 'bash.x86_64   5.1-2.el9   baseos\nkernel.x86_64  5.14-9.el9  baseos\n\nObsoleting Packages\nold.x86_64  1  2\n';
const DNF_SEC = 'dnf -C -q check-update --security';
const DNF_ALL = 'dnf -C -q check-update';
const DNF_CRIT = 'dnf -C -q updateinfo list --security --sec-severity=Critical';

test('dnf: exit 100 lists the packages (stops at Obsoleting); pending, security and critical counted', async () => {
  const r = await probe({ cmds: {
    [DNF_SEC]: { code: 100, stdout: DNF_LIST },
    [DNF_ALL]: { code: 100, stdout: DNF_LIST + 'x.x86_64 1 2\n' },
    [DNF_CRIT]: { code: 0, stdout: 'RHSA-1 Critical/Sec. bash-5\n\nRHSA-2 Critical/Sec. kernel-5\n' },
    'needs-restarting -r': { code: 1 },
  } })();
  assert.strictEqual(r.kind, 'dnf'); assert.strictEqual(r.security, 2); assert.strictEqual(r.pending, 2);
  assert.strictEqual(r.critical, 2); assert.strictEqual(r.restartRequired, true); assert.strictEqual(r.error, null);
});

test('dnf: exit 0 means none; needs-restarting 0 is "not needed", missing or other is null', async () => {
  const base = { [DNF_SEC]: { code: 0 }, [DNF_ALL]: { code: 0 }, [DNF_CRIT]: { code: 0 } };
  const r = await probe({ cmds: { ...base, 'needs-restarting -r': { code: 0 } } })();
  assert.strictEqual(r.security, 0); assert.strictEqual(r.pending, 0); assert.strictEqual(r.critical, 0); assert.strictEqual(r.restartRequired, false);
  assert.strictEqual((await probe({ cmds: base })()).restartRequired, null);
  assert.strictEqual((await probe({ cmds: { ...base, 'needs-restarting -r': { code: 3 } } })()).restartRequired, null);
});

test('dnf: another exit code is an error with null security; a failing critical query gives null critical', async () => {
  const r = await probe({ cmds: { [DNF_SEC]: { code: 1, stderr: 'Error: cache' }, [DNF_ALL]: { code: 100, stdout: DNF_LIST }, [DNF_CRIT]: { code: 1 } } })();
  assert.strictEqual(r.kind, 'dnf'); assert.strictEqual(r.security, null); assert.ok(r.error); assert.strictEqual(r.pending, 2); assert.strictEqual(r.critical, null);
});

test('zypper: the security table, a critical row, pending = security; restart from needs-restarting', async () => {
  const table = [
    'Repository | Name | Category | Severity | Interactive | Status | Since | Summary',
    '-----------+------+----------+----------+-------------+--------+-------+--------',
    'Update | openSUSE-1 | security | critical | ---  | needed | 2026-11-01 | kernel',
    'Update | openSUSE-2 | security | moderate | ---  | needed | 2026-11-02 | curl',
    'Update | openSUSE-3 | recommended | low | ---  | needed | 2026-11-02 | vim',
  ].join('\n');
  const r = await probe({ cmds: { 'zypper --non-interactive --no-refresh lp -g security': { stdout: table }, 'needs-restarting -r': { code: 1 } } })();
  assert.strictEqual(r.kind, 'zypper'); assert.strictEqual(r.security, 2); assert.strictEqual(r.critical, 1); assert.strictEqual(r.pending, 2); assert.strictEqual(r.restartRequired, true);
  const none = await probe({ cmds: { 'zypper --non-interactive --no-refresh lp -g security': { stdout: 'No updates found.\n' } } })();
  assert.strictEqual(none.security, 0); assert.strictEqual(none.restartRequired, null);
});

const SU = [
  'Software Update Tool', '', 'Finding available software',
  'Software Update found the following new or updated software:',
  '* Label: macOS Sonoma 14.5-23F79',
  '\tTitle: macOS Sonoma 14.5, Version: 14.5, Size: 6869472KiB, Recommended: YES, Action: restart,',
  '* Label: Safari17.5',
  '\tTitle: Safari, Version: 17.5, Size: 150000KiB, Recommended: NO,',
].join('\n');

test('macOS softwareupdate -l: two items (one restarts), the slow command gets timeoutMs', async () => {
  const calls = [];
  const r = await probe({ platform: 'darwin', calls, cmds: { 'softwareupdate -l': { stdout: SU } } });
  const o = await r({ timeoutMs: 90000 });
  assert.strictEqual(o.kind, 'softwareupdate'); assert.strictEqual(o.pending, 2); assert.strictEqual(o.security, 1);
  assert.strictEqual(o.restartRequired, true); assert.strictEqual(o.critical, null); assert.strictEqual(o.listsRefreshedAt, null);
  assert.strictEqual(calls[0].o.timeoutMs, 90000);
  const none = await probe({ platform: 'darwin', cmds: { 'softwareupdate -l': { stderr: 'Software Update Tool\n\nNo new software available.\n' } } })();
  assert.strictEqual(none.pending, 0); assert.strictEqual(none.security, 0); assert.strictEqual(none.restartRequired, false);
});

test('no package manager it recognises: kind null and an error', async () => {
  const r = await probe({})();
  assert.strictEqual(r.kind, null); assert.strictEqual(r.pending, null); assert.match(r.error, /no package manager it recognises/);
  const w = await probe({ platform: 'win32' })();
  assert.strictEqual(w.kind, null); assert.ok(w.error);
});

test('a timed-out command: null numbers and an error, the kind stays', async () => {
  const t = { code: null, timedOut: true };
  const a = await probe({ cmds: { [APT_GET]: t } })();
  assert.strictEqual(a.kind, 'apt'); assert.strictEqual(a.pending, null); assert.strictEqual(a.security, null); assert.match(a.error, /ran out of time/);
  const m = await probe({ platform: 'darwin', cmds: { 'softwareupdate -l': t } })();
  assert.strictEqual(m.kind, 'softwareupdate'); assert.strictEqual(m.pending, null); assert.match(m.error, /ran out of time/);
  const d = await probe({ cmds: { [DNF_SEC]: t, [DNF_ALL]: t, [DNF_CRIT]: t } })();
  assert.strictEqual(d.kind, 'dnf'); assert.strictEqual(d.security, null); assert.ok(d.error);
  const e = await probe({ cmds: { [APT_GET]: new Error('exec exploded') } })();   // an exec that throws never throws out
  assert.strictEqual(e.pending, null); assert.ok(e.error);
});

// ── judging ──
const T0 = Date.parse('2026-11-17T12:00:00Z');
function make({ platform = 'linux', settings = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'health-os-test-'));
  const clock = { now: T0 };
  const notices = [];
  const cfg = {
    os: { kind: 'apt', pending: 0, security: 0, critical: null, listsRefreshedAt: T0 - HOUR, restartRequired: false, restartPkgs: [], error: null },
    node: null, osThrows: false, settings,
  };
  const calls = { os: 0 };
  const probes = {
    disk: async () => ({ filesystems: [], errors: [] }),
    folderSizes: async () => [], memory: async () => ({ totalBytes: 8e9, availableBytes: 6e9, swapTotalBytes: 0, swapUsedBytes: 0, via: 'x' }),
    clock: async () => ({ synced: true, how: 'x' }), dbCheck: async () => ({ ok: true, result: 'ok', bytes: 1 }), fileSizes: async () => [],
    osUpdates: async () => { calls.os++; if (cfg.osThrows) throw new Error('os probe broke'); return cfg.os; },
  };
  const sh = createSystemHealth({
    probes, stateFile: path.join(dir, 'system-health.json'), now: () => clock.now, zone: () => 'America/New_York', settings: () => cfg.settings,
    paths: () => ({ disk: [], bigFolders: [], databases: [], logs: [] }), backupState: () => null,
    signIns: async () => [], localModels: async () => ({ installed: false, answers: null }),
    notify: async (payload, opts) => { notices.push({ payload, opts }); return { sent: 1 }; },
    nodeSecurity: () => { if (cfg.nodeThrows) throw new Error('x'); return cfg.node; }, platform,
    log: () => {}, limitMs: 2000,
  });
  return { sh, cfg, clock, notices, calls, dir };
}
const item = (v, id) => v.items.find(i => i.id === id);
const nightly = (h) => h.sh.run({ trigger: 'nightly', full: true });
const manual = (h, full = true) => h.sh.run({ trigger: 'manual', full });
const OS = 'health-os-updates', LISTS_ID = 'health-os-lists', RESTART = 'health-os-restart', NODE = 'health-node';
const nodeInfo = (over = {}) => ({ behind: true, version: 'v22.1.0', date: '2026-10-01', rated: 'high', floor: 'v22.9.0', how: 'Run the one-line installer again.', ...over });

test('os-updates: ok, warn, critical, unknown at each level; fix by kind', async () => {
  const h = make();
  let v = await manual(h);
  assert.strictEqual(item(v, OS).level, 'ok'); assert.strictEqual(item(v, OS).title, 'No security updates waiting');
  h.cfg.os = { ...h.cfg.os, pending: 261 };
  assert.strictEqual(item(await manual(h), OS).title, 'No security updates waiting; 261 other updates');
  h.cfg.os = { ...h.cfg.os, security: 1 };
  let it = item(await manual(h), OS);
  assert.strictEqual(it.level, 'warn'); assert.strictEqual(it.title, '1 security update is waiting'); assert.strictEqual(it.fix, 'Run sudo apt upgrade, then restart when convenient.');
  h.cfg.os = { ...h.cfg.os, security: 4 };
  assert.strictEqual(item(await manual(h), OS).title, '4 security updates are waiting');
  h.cfg.os = { ...h.cfg.os, security: 4, critical: 2 };
  it = item(await manual(h), OS);
  assert.strictEqual(it.level, 'critical'); assert.strictEqual(it.title, '2 critical security updates are waiting');
  h.cfg.os = { ...h.cfg.os, critical: 1 };
  assert.strictEqual(item(await manual(h), OS).title, '1 critical security update is waiting');
  h.cfg.os = { ...h.cfg.os, security: null, critical: null };
  assert.strictEqual(item(await manual(h), OS).level, 'unknown');
  for (const [kind, fix] of [['dnf', 'Run sudo dnf upgrade --security, then restart when convenient.'], ['zypper', 'Run sudo zypper patch -g security, then restart when convenient.'], ['softwareupdate', 'Open System Settings → General → Software Update.']]) {
    h.cfg.os = { ...h.cfg.os, kind, security: 1, critical: null };
    assert.strictEqual(item(await manual(h), OS).fix, fix);
  }
});

test('os-updates: the detail says how old the update lists are, only when known', async () => {
  const h = make();
  h.cfg.os = { ...h.cfg.os, security: 1, listsRefreshedAt: T0 - 3 * DAY - HOUR };
  assert.strictEqual(item(await manual(h), OS).detail, 'Update lists last refreshed 3 days ago.');
  h.cfg.os = { ...h.cfg.os, listsRefreshedAt: null };
  assert.strictEqual(item(await manual(h), OS).detail, '');
});

test('os-updates: kind null and a throwing probe are unknown, never ok', async () => {
  const h = make();
  h.cfg.os = { kind: null, pending: null, security: null, critical: null, listsRefreshedAt: null, restartRequired: null, restartPkgs: [], error: 'no package manager it recognises' };
  let v = await manual(h);
  assert.strictEqual(item(v, OS).level, 'unknown'); assert.strictEqual(item(v, OS).title, "Operating-system updates couldn't be checked");
  assert.strictEqual(item(v, LISTS_ID), undefined); assert.strictEqual(item(v, RESTART), undefined);
  h.cfg.os = { ...h.cfg.os, kind: 'apt', security: 0 };
  assert.strictEqual(item(await manual(h), OS).level, 'ok');
  h.cfg.osThrows = true;
  v = await manual(h);
  assert.strictEqual(item(v, OS).level, 'unknown'); assert.strictEqual(item(v, OS).title, "Operating-system updates couldn't be checked");
});

test('escalation: warn on day 1, critical after 8 days with the wait in the title, notified once as critical', async () => {
  const h = make();
  h.cfg.os = { ...h.cfg.os, security: 3 };
  let v = await nightly(h);
  assert.strictEqual(item(v, OS).level, 'warn'); assert.strictEqual(h.notices.length, 0);
  h.clock.now = T0 + 7 * DAY;   // exactly 7 days is not "more than 7 days"
  v = await nightly(h);
  assert.strictEqual(item(v, OS).level, 'warn');
  h.clock.now = T0 + 8 * DAY;
  v = await nightly(h);
  assert.strictEqual(item(v, OS).level, 'critical'); assert.strictEqual(item(v, OS).title, '3 security updates are waiting (waiting 8 days)');
  assert.strictEqual(v.critical, 1);
  assert.strictEqual(h.notices.length, 1); assert.strictEqual(h.notices[0].opts.urgency, 'high'); assert.match(h.notices[0].payload.title, /waiting 8 days/);
  h.clock.now = T0 + 9 * DAY;
  v = await nightly(h);
  assert.strictEqual(item(v, OS).title, '3 security updates are waiting (waiting 9 days)');
  assert.strictEqual(h.notices.length, 1, 'once');
});

test('macOS: security 2 is a warning "2 recommended updates are waiting" and never escalates; apt still does', async () => {
  const h = make({ platform: 'darwin' });
  h.cfg.os = { ...h.cfg.os, kind: 'softwareupdate', security: 2 };
  let v = await nightly(h);
  assert.strictEqual(item(v, OS).level, 'warn');
  assert.strictEqual(item(v, OS).title, '2 recommended updates are waiting');
  h.clock.now = T0 + 8 * DAY;
  v = await nightly(h);
  h.clock.now = T0 + 12 * DAY;
  v = await nightly(h);
  assert.strictEqual(item(v, OS).level, 'warn', 'no escalation on macOS');
  assert.doesNotMatch(item(v, OS).title, /\(waiting/);
  assert.strictEqual(item(v, OS).title, '2 recommended updates are waiting');
  assert.strictEqual(h.notices.length, 0);
  const a = make();
  a.cfg.os = { ...a.cfg.os, kind: 'apt', security: 2 };
  await nightly(a); a.clock.now = T0 + 8 * DAY;
  assert.strictEqual(item(await nightly(a), OS).level, 'critical');
});

test('escalation: a fixed problem starts over (the wait counts from the new warning)', async () => {
  const h = make();
  h.cfg.os = { ...h.cfg.os, security: 3 };
  await nightly(h);
  h.clock.now = T0 + 5 * DAY; h.cfg.os = { ...h.cfg.os, security: 0 };
  assert.strictEqual(item(await nightly(h), OS).level, 'ok');
  h.clock.now = T0 + 9 * DAY; h.cfg.os = { ...h.cfg.os, security: 3 };
  assert.strictEqual(item(await nightly(h), OS).level, 'warn');
});

test('escalation also applies to the Node.js watch', async () => {
  const h = make();
  h.cfg.node = nodeInfo();
  assert.strictEqual(item(await nightly(h), NODE).level, 'warn');
  h.clock.now = T0 + 8 * DAY;
  const it = item(await nightly(h), NODE);
  assert.strictEqual(it.level, 'critical'); assert.match(it.title, /\(waiting 8 days\)$/);
  assert.strictEqual(h.notices.length, 1);
});

test('os-lists: no item until the lists are over 7 days old; clears with "fixed" when refreshed', async () => {
  const h = make({ settings: { notify: 'warnings', warnNights: 1 } });
  h.cfg.os = { ...h.cfg.os, listsRefreshedAt: T0 - 7 * DAY };
  assert.strictEqual(item(await nightly(h), LISTS_ID), undefined, 'exactly 7 days is fine');
  h.cfg.os = { ...h.cfg.os, listsRefreshedAt: T0 - 8 * DAY };
  const it = item(await nightly(h), LISTS_ID);
  assert.strictEqual(it.level, 'warn'); assert.strictEqual(it.title, 'The list of available updates is 8 days old');
  assert.strictEqual(it.fix, 'Run sudo apt update (or turn on automatic updates), so new security fixes are seen.');
  assert.strictEqual(h.notices.length, 1);
  h.clock.now = T0 + DAY; h.cfg.os = { ...h.cfg.os, listsRefreshedAt: h.clock.now - HOUR };
  const v = await nightly(h);
  assert.strictEqual(item(v, LISTS_ID), undefined);
  assert.strictEqual(h.notices.length, 2); assert.strictEqual(h.notices[1].payload.title, 'Health: fixed');
  // unknown refresh time: no item at all
  h.cfg.os = { ...h.cfg.os, listsRefreshedAt: null };
  assert.strictEqual(item(await nightly(h), LISTS_ID), undefined);
});

test('os-restart: warn with the packages (at most 10), ok when not needed, no item when unknown', async () => {
  const h = make();
  h.cfg.os = { ...h.cfg.os, restartRequired: true, restartPkgs: Array.from({ length: 15 }, (_, i) => `pkg${i}`) };
  let it = item(await manual(h), RESTART);
  assert.strictEqual(it.level, 'warn'); assert.strictEqual(it.title, 'A restart is needed to finish installing updates');
  assert.match(it.detail, /pkg9/); assert.doesNotMatch(it.detail, /pkg10/);
  assert.strictEqual(it.fix, 'Restart the computer when convenient; your Maestro comes back by itself if it runs as a service.');
  h.cfg.os = { ...h.cfg.os, restartRequired: true, restartPkgs: [] };
  assert.strictEqual(item(await manual(h), RESTART).detail, '');
  h.cfg.os = { ...h.cfg.os, restartRequired: false };
  it = item(await manual(h), RESTART);
  assert.strictEqual(it.level, 'ok'); assert.strictEqual(it.title, 'No restart needed for updates');
  h.cfg.os = { ...h.cfg.os, restartRequired: null };
  assert.strictEqual(item(await manual(h), RESTART), undefined);
});

test('node: warn, critical when rated critical, ok, and no item when null or throwing', async () => {
  const h = make();
  assert.strictEqual(item(await manual(h), NODE), undefined, 'null: no item');
  h.cfg.node = nodeInfo();
  let it = item(await manual(h), NODE);
  assert.strictEqual(it.level, 'warn'); assert.strictEqual(it.title, 'Node.js v22.1.0 is missing security fixes');
  assert.match(it.detail, /2026-10-01/); assert.match(it.detail, /high/); assert.match(it.detail, /v22\.9\.0/);
  assert.strictEqual(it.fix, 'Run the one-line installer again.');
  h.cfg.node = nodeInfo({ rated: 'Critical' });
  assert.strictEqual(item(await manual(h), NODE).level, 'critical');
  h.cfg.node = nodeInfo({ behind: false });
  it = item(await manual(h), NODE);
  assert.strictEqual(it.level, 'ok'); assert.strictEqual(it.title, 'Node.js v22.1.0 has the current security fixes');
  h.cfg.node = nodeInfo(); h.cfg.nodeThrows = true;
  assert.strictEqual(item(await manual(h), NODE), undefined, 'a throwing check shows nothing (and not the old item)');
});

test('darwin: a start run does not call osUpdates and keeps the last items; other runs do', async () => {
  const h = make({ platform: 'darwin' });
  h.cfg.os = { ...h.cfg.os, kind: 'softwareupdate', security: 2, restartRequired: true };
  await manual(h);
  assert.strictEqual(h.calls.os, 1);
  h.cfg.os = { ...h.cfg.os, security: 0, restartRequired: false };
  const v = await h.sh.run({ trigger: 'start', full: true });
  assert.strictEqual(h.calls.os, 1, 'softwareupdate is slow: not at start');
  assert.strictEqual(item(v, OS).level, 'warn'); assert.strictEqual(item(v, RESTART).level, 'warn');
  const v2 = await nightly(h);
  assert.strictEqual(h.calls.os, 2);
  assert.strictEqual(item(v2, OS).level, 'ok');
});

test('linux: a start run does call osUpdates (only macOS skips it)', async () => {
  const h = make();
  await h.sh.run({ trigger: 'start', full: true });
  assert.strictEqual(h.calls.os, 1);
});

test('a partial run (full=false) skips the OS and Node checks and keeps their items', async () => {
  const h = make();
  h.cfg.os = { ...h.cfg.os, security: 2 }; h.cfg.node = nodeInfo();
  await manual(h);
  h.cfg.os = { ...h.cfg.os, security: 0 }; h.cfg.node = null;
  const v = await manual(h, false);
  assert.strictEqual(h.calls.os, 1);
  assert.strictEqual(item(v, OS).level, 'warn'); assert.strictEqual(item(v, NODE).level, 'warn');
});

test('probes without osUpdates (older fakes) leave the OS checks out instead of showing unknown', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'health-os-test-'));
  const sh = createSystemHealth({ probes: { disk: async () => ({ filesystems: [], errors: [] }), memory: async () => ({ totalBytes: 1, availableBytes: 1 }) }, stateFile: path.join(dir, 's.json'), signIns: async () => [], limitMs: 500 });
  const v = await sh.run({ trigger: 'manual', full: true });
  assert.strictEqual(item(v, OS), undefined);
});
