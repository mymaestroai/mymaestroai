'use strict';
// The one device group and the limited agent account's rights on it.

const GROUP_NAME = 'My Maestro computers';
const GROUP_DESC = 'Computers My Maestro agents may look at or, with approval, control';
// REMOTECOMMAND 131072 + DEVICEDETAILS 1048576 + CHATNOTIFY 16384 + NODESKTOP 65536 + NOTERMINAL 512 + NOFILES 1024
const AGENT_RIGHTS = 131072 + 1048576 + 16384 + 65536 + 512 + 1024;   // 1263104

// The desktop's account: the person at the viewer. Remote control of the screen and nothing else (MeshCentral 1.3.1 meshuser.js:40-64):
// REMOTECONTROL 8 + NOTERMINAL 512 + NOFILES 1024 + NOREGISTRY 4194304 + NOSOFTWARE 8388608. Without the NO* bits MeshCentral would allow a
// terminal, files, registry and software tunnels for this user (it only refuses them when those bits are set). Not set: REMOTEVIEWONLY 256 and
// NODESKTOP 65536 (they would stop the screen or the input), DESKLIMITEDINPUT 4096, AGENTCONSOLE 16 and REMOTECOMMAND 131072 (commands).
const PERSON_USER = 'person';
const PERSON_RIGHTS = 8 + 512 + 1024 + 4194304 + 8388608;   // 12584456 (the sum 12583432 in the first notes left out NOFILES 1024)
const CHANGEPASS_WAIT_MS = 3000;   // changeuserpass is never answered (meshuser.js:2054: every outcome is silent)

/**
 * ensurePerson(adminClient, meshid, store, { newPass }) -> { user, pass }. Idempotent, like ensureGroup.
 * store: { read() -> { user, pass } | null, write(pass) }. The password is remembered before the account is made, so a failure in between
 * does not lose it. A user that already exists gets its password set again (changeuserpass), then (every time) its rights on the group.
 */
async function ensurePerson(adminClient, meshid, store, { newPass = () => require('node:crypto').randomBytes(24).toString('base64url') } = {}) {
  let acct = store.read();
  if (!acct || typeof acct.pass !== 'string' || !acct.pass) { const pass = newPass(); store.write(pass); acct = { user: PERSON_USER, pass }; }
  try {
    await adminClient.request('adduser', { username: PERSON_USER, pass: acct.pass });
  } catch (e) {
    if (!(e && e.code === 'EMESH' && /already exists/i.test(String(e.message)))) throw e;
    try { await adminClient.request('changeuserpass', { userid: `user//${PERSON_USER}`, pass: acct.pass, removeMultiFactor: false }, { timeoutMs: CHANGEPASS_WAIT_MS }); } catch (e2) {
      if (!(e2 && e2.code === 'ETIMEDOUT')) throw e2;   // no answer is the normal outcome
    }
  }
  const a = await adminClient.request('addmeshuser', { meshid, usernames: [PERSON_USER], meshadmin: PERSON_RIGHTS });
  if (!(Number(a && a.success) > 0)) throw new Error('The desktop account could not be added to the device group.');
  return { user: PERSON_USER, pass: acct.pass };
}

/**
 * ensureGroup(adminClient, state) -> meshid.
 * state: { read() -> { meshid? }, write(obj) }. Creates the group when none is remembered, then (every time, it is idempotent) gives the
 * 'maestro' account its limited rights on it, and remembers the group.
 */
async function ensureGroup(adminClient, state, { agentUser = 'maestro' } = {}) {
  const known = state.read() || {};
  let meshid = typeof known.meshid === 'string' && known.meshid ? known.meshid : null;
  if (!meshid) {
    const r = await adminClient.request('createmesh', { meshname: GROUP_NAME, desc: GROUP_DESC, meshtype: 2, consent: 0 });
    if (!r || typeof r.meshid !== 'string' || !r.meshid) throw new Error('The server did not return the new device group.');
    meshid = r.meshid;
    state.write({ ...known, meshid });   // saved at once: a failure below must not make a second group on the next try
  }
  // The client treats a reply with success > 0 as the success (the text of an addmeshuser reply is a message, not "ok").
  const a = await adminClient.request('addmeshuser', { meshid, usernames: [agentUser], meshadmin: AGENT_RIGHTS });
  if (!(Number(a && a.success) > 0)) throw new Error('The agent account could not be added to the device group.');
  return meshid;
}

module.exports = { ensureGroup, ensurePerson, AGENT_RIGHTS, PERSON_RIGHTS, PERSON_USER, GROUP_NAME };
