'use strict';

/**
 * tools.js — the comms tools an agent sees, and who is allowed to see them.
 *
 * ACCESS: an agent may use these tools only if it is listed in a channel's
 * `agents` array (service.js config, editable from the owner UI). There is
 * no separate global allow-list: the per-channel agents array IS the gate.
 *
 * runTool takes a tool NAME (not a spec object, unlike wallet/tools.js) so
 * callers can dispatch straight off the tool call's `name` field.
 */

const clean = (o) => JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : typeof v === 'bigint' ? v.toString() : v), 2);

function isCommsAgent(agentName, getService = () => require('./service').getCommsService()) {
  if (!agentName) return false;
  try { if (require('../temporal-workers').isVirtual(agentName)) return false; } catch { /* module optional */ }
  try {
    const channels = getService().config.channels;
    return Object.values(channels).some(ch => Array.isArray(ch.agents) && ch.agents.includes(String(agentName)));
  } catch { return false; }
}

/** One definition per tool: JSON-schema params (gateway agents), a zod shape (SDK agents), and the handler. */
function toolSpecs(getService = () => require('./service').getCommsService()) {
  return [
    { name: 'comms_channels',
      description: 'List messaging channels reachable from this agent: which are enabled, recipients you may message, and whether you are allowed to send. Call this before comms_send.',
      parameters: { type: 'object', properties: {} }, zod: () => ({}),
      run: async (a, agent) => getService().channelsInfo(agent) },

    { name: 'comms_send',
      description: 'Send a message to a person over a messaging channel. channel: "telegram". to: a recipient name or id from comms_channels; unlisted recipients are refused. If you are not the channel owner, an automatic AI-disclosure prefix is added to the message and cannot be removed.',
      parameters: { type: 'object', properties: { channel: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'to', 'text'] },
      zod: z => ({ channel: z.string(), to: z.string(), text: z.string() }),
      run: async (a, agent) => getService().send({ ...a, agent }) },
  ];
}

/** Run a tool by name and always return a string: results as JSON, failures as a plain explanation (never a stack). */
async function runTool(name, args, agentName, getService = () => require('./service').getCommsService()) {
  if (!isCommsAgent(agentName, getService)) return `[DENIED] Agent "${agentName}" is not authorised to use comms tools.`;
  const spec = toolSpecs(getService).find(s => s.name === name);
  if (!spec) return `[COMMS ERROR] Unknown tool "${name}".`;
  try { return clean(await spec.run(args || {}, agentName)); }
  catch (e) { return `[COMMS ERROR] ${e.message}`; }
}

module.exports = { toolSpecs, runTool, isCommsAgent };
