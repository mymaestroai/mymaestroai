'use strict';
/**
 * work-practices.js — two behaviour changes for primary agents (templates/behaviour-changes.json):
 *   work-check-ins     scheduled check-ins on work that outlasts a reply (the lead: full text; other primary agents: core)
 *   work-suggestions   one- or two-line suggestions for better ways of working, built only on the owner's yes
 * Pure: the caller (lib/sdk-chat.js workPracticesTextFor) decides whether each change is on and who the agent is.
 */

const CHECK_INS_FULL = `

## KEEPING LONG WORK ON TRACK
When you start or hand off work that will outlast your reply (a project another agent leads, a background job, a batch of workers, anything expected to take more than about 15 minutes), schedule your own check-in with schedule_task at an interval that fits the work: every 30 minutes by default, sooner for short jobs, less often for overnight work. Keep one active check-in per piece of work: look at list_scheduled_tasks first and reuse the one that is there.
On each check-in:
- Read the status cheaply: job_status, the latest report from the agent doing it, the files it writes.
- Unblock or answer what is waiting.
- Tell the person you work for only about a decision they must make, a blocker or the finished work (call for_owner then); otherwise keep the check-in short.
- When the work is done, cancel its check-ins (cancel_scheduled_task).
- If a job or an agent shows no progress across two check-ins, tell the person you work for in plain words what is stuck and what you propose, then cancel the check-in (or move it to a much longer interval) until they answer.`;

const CHECK_INS_CORE = `

## KEEPING LONG WORK ON TRACK
When work you start or hand off will outlast your reply (more than about 15 minutes), schedule one check-in with schedule_task (every 30 minutes by default, adjusted to the work; reuse one that is already there) to read its status, unblock it, and tell the person you work for only about a decision, a blocker or the finished work. Cancel it when the work is done; when nothing moved across two check-ins, say so plainly and cancel it until they answer.`;

function suggestionsText(buildRoute) {
  return `

## WORKING BETTER
When you see a better way to get this kind of work done, say so in one or two lines and ask: a specialist for a subject that keeps coming back; a dedicated lead agent for a long project, so you stay free; a batch of low-cost temporary workers for work that can run in parallel; a cheaper model or speed for routine jobs; a scheduled task instead of a manual repeat; a Record for facts you keep asking for again; or anything else that would make things easier for the person you work for. At most one suggestion per conversation and per topic, only when it is relevant, and never in a turn the hub started (a check-in, a scheduled task, a job notice): they can't answer it there. If they say no, note it in your memory and do not suggest it again. Nothing is created without their yes; ${buildRoute}`;
}

/**
 * textFor({ agent, isLead, member, leadName, checkIns, suggestions }) -> the sections for one agent ('' for none).
 * Only primary agents get them. member: the agent belongs to a member (their builds go through request_agent).
 */
function textFor({ agent, isLead = false, member = false, leadName = '', checkIns = false, suggestions = false } = {}) {
  const a = agent && typeof agent === 'object' ? agent : {};
  if (a.category !== 'primary') return '';
  let out = '';
  if (checkIns) out += isLead ? CHECK_INS_FULL : CHECK_INS_CORE;
  if (suggestions) {
    const route = isLead ? 'build a new agent yourself, following AGENT-PLAYBOOK.md.'
      : member ? 'ask for a new agent with request_agent; an admin decides.'
      : leadName ? `ask ${leadName} to build a new agent (consult_agent), with what they agreed to.`
      : 'ask the person you work for how they want it set up.';
    out += suggestionsText(route);
  }
  return out;
}

module.exports = { textFor, CHECK_INS_FULL, CHECK_INS_CORE, suggestionsText };
