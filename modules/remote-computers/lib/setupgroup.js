'use strict';
// The one device group and the limited agent account's rights on it.

const GROUP_NAME = 'My Maestro computers';
const GROUP_DESC = 'Computers My Maestro agents may look at or, with approval, control';
// REMOTECOMMAND 131072 + DEVICEDETAILS 1048576 + CHATNOTIFY 16384 + NODESKTOP 65536 + NOTERMINAL 512 + NOFILES 1024
const AGENT_RIGHTS = 131072 + 1048576 + 16384 + 65536 + 512 + 1024;   // 1263104

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

module.exports = { ensureGroup, AGENT_RIGHTS, GROUP_NAME };
