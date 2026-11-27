'use strict';
/**
 * work-practices.js — behaviour changes for primary agents (templates/behaviour-changes.json):
 *   work-check-ins     scheduled check-ins on work that outlasts a reply (the lead: full text; other primary agents: core)
 *   work-suggestions   one- or two-line suggestions for better ways of working, built only on the owner's yes
 *   parallel-work      complex work split across parallel workers unless splitting hurts quality (the lead: full text; others: core)
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

/** The hand-off rule (behaviour change 'hand-off-guidance'): long work goes to a build partner, the agent stays free. */
function handOffsText({ partner = '', isLead = false, member = false, leadName = '' } = {}) {
  const who = partner ? `your build partner, ${partner} (or another teammate),` : 'a teammate';
  const none = partner ? ''
    : isLead ? ' You have no build partner: when long work keeps coming back, propose one to the person you work for.'
    : member ? ' You have no build partner yet: if long work keeps coming back, say so and ask for one with request_agent.'
    : leadName ? ` You have no build partner yet: if long work keeps coming back, ask ${leadName} for one (consult_agent).`
    : ' You have no build partner yet: if long work keeps coming back, ask the person you work for whether to add one.';
  const lead = isLead ? '\n- When you create a primary agent whose work includes long development or creative production, also create its build partner and write this rule into both agents\' files (AGENT-PLAYBOOK.md, "Build partners").' : '';
  return `\n\n## LONG WORK: HAND IT OFF
- Never wait on long work inside your own turn. Anything longer than a few minutes (development, production, long research) goes to ${who} with hand_off; you stay free to talk with the person you work for.${none}
- The brief is complete: the goal, the decisions made, the files, what done means, what not to touch. Your turn then ends.
- The other agent keeps STATUS.md current (hand_off_list shows it): read it when asked how the work is going. Its report comes back to you as a new turn: review it, then tell the person what matters.
- Quick look-ups and checks of a minute or two you still do yourself.${lead}`;
}

/** The parallel-work rule (behaviour change 'parallel-work'): split complex work into independent parts, unless splitting hurts quality.
 *  kept: the agent's content stays on its own service (sdk-chat researchKeptOnBox), so no other company's model is suggested. */
function parallelText({ isLead = false, handOffs = false, kept = false } = {}) {
  const reviews = kept ? 'several reviewers side by side' : "reviews from different companies' models side by side";
  const models = kept
    ? '\n- Your work stays on your own service: every worker and reviewer runs on your own model, never on another company\'s, and you consult or hand work only to agents on your own service.'
    : '\n- Pick the model for each part from the models you may use, and know why: a cheaper model for volume where it does that part as well, the strongest model where the part decides the quality.';
  const hand = handOffs ? '\n- Work that will take more than a few minutes still goes to a teammate with hand_off, rather than being split and waited on in your own turn; the teammate that leads it does the splitting.' : '';
  const lead = isLead ? '\n- When the agents that lead work for you are all busy and more work is waiting, you may create another lead for yourself, following AGENT-PLAYBOOK.md, rather than lend a specialist from another field.' + (kept ? ' Give it a model on your own service.' : '') : '';
  return `\n\n## COMPLEX WORK: SPLIT IT, UNLESS SPLITTING HURTS
- For any complex task, first look for parts that don't depend on each other. Where running them separately keeps the quality, start them at the same time, without being asked: several consult_agent or spawn_workers calls in one message, several leads or hand-offs at once where you have them, ${reviews}.${models}
- Quality comes first. Keep work in one thread where splitting would make it worse: one design or writing voice, tightly coupled changes to the same files, a chain of decisions where each step depends on the last, the final judgement and putting the parts together. Say in one line why it stays in one thread.
- Check every part that comes back before you use it, and put the parts together yourself.
- Don't split trivial jobs or look-ups of a minute or two.${hand}${lead}`;
}

/** The rule about the install's own code (behaviour change 'own-code-guidance'): the lead only. */
function ownCodeText() {
  return `\n\n## YOUR MAESTRO'S OWN CODE
- Never change your Maestro's own program files on this computer (its folder, except data/ and the workspaces). A local change stops the next update, and breaks when the code it relies on changes.
- When something should work differently, describe the change to the person you work for and offer to send it to the project as an idea or a pull request.
- If they insist on a local change, warn them plainly that it will stop updates. Never put back changes that were put aside (git stash pop or apply); that is theirs to do.`;
}

/**
 * textFor({ agent, isLead, member, leadName, checkIns, suggestions, handOffs, parallel, kept }) -> the sections for one agent ('' for none).
 * Only primary agents get them. member: the agent belongs to a member (their builds go through request_agent). kept: its
 * content stays on its own service (parallel-work then names no other company's model).
 */
function textFor({ agent, isLead = false, member = false, leadName = '', checkIns = false, suggestions = false, handOffs = false, partner = '', ownCode = false, parallel = false, kept = false } = {}) {
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
  if (handOffs) out += handOffsText({ partner, isLead, member, leadName });
  if (parallel) out += parallelText({ isLead, handOffs, kept });
  if (ownCode && isLead) out += ownCodeText();
  return out;
}

module.exports = { textFor, ownCodeText, parallelText, CHECK_INS_FULL, CHECK_INS_CORE, suggestionsText, handOffsText };
