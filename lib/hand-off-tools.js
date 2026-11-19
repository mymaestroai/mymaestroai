'use strict';
// The hand-off tools (lib/hand-offs runs them): a primary agent or a lead hands a long job to another agent and stays
// free to talk with the person it works for. Offered only on the agent's own turns (consultation depth 0), never to a
// temporary worker; a target's hand-off turn runs at consult depth, so it can't hand off further. Who may be a target is
// the consult_agent rule (lib/sdk-chat consultAllowed), unchanged.

const TOOL_SPECS = [
  {
    name: 'hand_off',
    description: 'Hand a long job to another agent and stay free to talk: it starts that agent\'s work in the background and returns at once. '
      + 'Use it for anything that would take more than a few minutes (development, production, long research) instead of waiting on workers or a consultation inside your own turn. '
      + 'The other agent keeps a STATUS.md next to the brief (hand_off_list shows it); its final report comes back to you as a new turn ("[Hand-off finished] ..."). '
      + 'Only agents you may consult; at most 5 open at once.',
    params: {
      agent: { type: 'string', description: 'The agent to hand the job to (list_agents shows them)' },
      topic: { type: 'string', description: 'A short title (up to 80 characters), used for the job folder' },
      brief: { type: 'string', description: 'Everything the other agent needs: the goal, decisions made, files, what done means, what not to touch' },
    },
  },
  {
    name: 'hand_off_list',
    description: 'Your hand-offs with their state and each one\'s latest STATUS.md (open ones and those that ended in the last day).',
    params: { include_done: { type: 'string', description: '"true" to include every finished one', optional: true } },
  },
  {
    name: 'hand_off_note',
    description: 'Send a note to the agent working on one of your hand-offs (a correction, an answer, a new detail). It reaches the agent now if it is working, or starts its next step.',
    params: {
      id: { type: 'string', description: 'The hand-off id (ho-...)' },
      text: { type: 'string', description: 'The note' },
    },
  },
  {
    name: 'hand_off_cancel',
    description: 'Stop one of your hand-offs: the other agent\'s running step stops and its scheduled continuations are cancelled. No report follows.',
    params: { id: { type: 'string', description: 'The hand-off id (ho-...)' } },
  },
];

function stateWords(v) {
  return { queued: 'queued: it starts as soon as that agent is free', running: 'running', waiting: 'waiting for its next step', done: 'done', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted by a restart' }[v.state] || v.state;
}

/**
 * Run one hand-off tool for `caller`. deps: { runner, mayTarget(caller, target) -> Promise<bool>, isVirtual(name) -> bool,
 * member: bool }. Always plain text: the result or the refusal.
 */
async function runTool(name, args, caller, deps) {
  const a = args || {};
  const { runner } = deps;
  try {
    if (name === 'hand_off') {
      const target = String(a.agent || '').trim();
      if (!target) return 'Say which agent to hand the job to.';
      if (target === caller) return "You can't hand off to yourself.";
      if (deps.isVirtual && deps.isVirtual(target)) return `${target} is a temporary worker; hand off to a named agent.`;
      if (!(await deps.mayTarget(caller, target))) return `You can't hand off to "${target}": hand-offs go only to agents you may consult.`;
      const v = await runner.create({ caller, target, topic: a.topic, brief: a.brief, member: !!deps.member });
      return [
        `Handed off to ${target} (id ${v.id}): ${stateWords(v)}.`,
        `The brief is saved at ${v.folder}/brief.md; ${target} keeps ${v.folder}/STATUS.md current (hand_off_list shows it).`,
        `Its report comes back to you as a new turn when it is done. You are free: tell the person you work for, and carry on.`,
      ].join('\n');
    }
    if (name === 'hand_off_list') {
      const rows = await runner.listWithStatus(caller, { includeDone: String(a.include_done || '').toLowerCase() === 'true' });
      if (!rows.length) return 'No hand-offs.';
      return rows.map(v => [
        `${v.id} to ${v.target}: "${v.topic}", ${stateWords(v)}${v.turns ? `, ${v.turns} step${v.turns === 1 ? '' : 's'} so far` : ''}${v.queuedNotes ? `, ${v.queuedNotes} note${v.queuedNotes === 1 ? '' : 's'} waiting` : ''}.`,
        `  Folder: ${v.folder}`,
        v.status ? `  STATUS.md:\n${v.status.split('\n').map(l => '    ' + l).join('\n')}` : '  STATUS.md: not written yet.',
      ].join('\n')).join('\n');
    }
    if (name === 'hand_off_note') {
      const v = runner.note({ caller, id: String(a.id || '').trim(), text: a.text });
      return v.state === 'running' && !v.queuedNotes ? `Note delivered to ${v.target}.` : `Note kept for ${v.target}: it gets it with its next step.`;
    }
    if (name === 'hand_off_cancel') {
      const v = runner.cancel({ caller, id: String(a.id || '').trim() });
      return `Cancelled ${v.id} ("${v.topic}"): ${v.target}'s running step was stopped and its scheduled continuations cancelled. The folder stays at ${v.folder}.`;
    }
    return `Unknown tool ${name}.`;
  } catch (e) { return e.message; }
}

/** JSON schema for the gateway tool list. */
function jsonSchema(spec) {
  const properties = {}; const required = [];
  for (const [k, p] of Object.entries(spec.params)) { properties[k] = { type: p.type, description: p.description }; if (!p.optional) required.push(k); }
  return { type: 'object', properties, required };
}
/** zod shape for the SDK's MCP tools. */
function zodShape(spec, z) {
  const shape = {};
  for (const [k, p] of Object.entries(spec.params)) { let t = z.string().describe(p.description); if (p.optional) t = t.optional(); shape[k] = t; }
  return shape;
}

module.exports = { TOOL_SPECS, runTool, jsonSchema, zodShape, stateWords };
