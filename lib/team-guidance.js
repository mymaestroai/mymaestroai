'use strict';

/**
 * team-guidance.js — the short "how to run a team" section of an agent's system prompt.
 *
 * One place builds it, and lib/sdk-chat.js appends it every turn, so old and new agents get the current text.
 * Global setting `teamGuidance` (data/settings.json, /api/team_guidance): 'full' (default) | 'light' | 'off'.
 * Per-agent field `teamGuidance`: 'inherit' (default, field absent) | 'on' | 'off'.
 * Lead agents get the whole text; other agents the core text; small local models and minimal-context agents the light text.
 */

const LEVELS = ['full', 'light', 'off'];
const DEFAULT_LEVEL = 'full';
const AGENT_VALUES = ['inherit', 'on', 'off'];

function normalizeLevel(v) {
  const l = String(v || '').trim().toLowerCase();
  return LEVELS.includes(l) ? l : DEFAULT_LEVEL;
}

function getLevel() {
  try { return normalizeLevel(require('./settings').getSetting('teamGuidance', DEFAULT_LEVEL)); }
  catch { return DEFAULT_LEVEL; }
}

const HEADING = '\n\n## RUNNING A TEAM\n';

const FULL_INTRO = 'You lead; your workers do the volume. Plan, decide and check yourself. Do a small job (a few tool calls, a lookup whose answer you know where to find) yourself; hand off reading across many files, independent parts that can run at once, and long work.';
const CORE_INTRO = 'When a job is bigger than a few tool calls, work as a lead: plan, decide and check yourself; hand off reading across many files, independent parts that can run at once, and long work.';

const B_MODELS = '- Match the model to the job. Fast, cheap models for lookups, searches, summaries and reformatting. Mid-tier models for coding from a clear spec, multi-step file work and routine reviews. The top tier only for leading, planning and hard reviews. Never put a lead or planner on a cheap model. A worker\'s or reviewer\'s model should differ from yours when the point is a second opinion. A subscription route costs nothing extra per use until its plan limit; an API key is billed per use: prefer the subscription for volume.';
const B_BRIEFS = '- Write briefs that stand alone. Goal, exact paths or sources, constraints, what not to touch, and the shape of the answer you want. The worker sees nothing of your conversation.';
const B_ONE_JOB = '- One agent, one job. Send independent parts to different workers in the same message; queue the rest.';
const B_SECOND = '- Get a second opinion and a challenge on anything important (a change to code, money, security, a document going out). Ask a reviewer on a different model, ideally from a different vendor, and your challenger for an adversarial pass. Weigh each finding and answer it with reasons. After two rounds of new objections on the same point, ask the challenger for the concrete fix. Settle disputes by running the real thing, not by argument. If you are still split, ask the person you work for one clear question with your recommendation.';
const B_REVIEW = '- When you ask for a review, give the reviewer the work, not your conclusion: a reviewer handed your answer tends to agree with it.';
const B_JUDGE = '- Judge models by their results on your work. If a worker or reviewer is often wrong, say so and use a different model.';
const B_CHECK = '- Check the work before you rely on it. Read what workers changed, name failures exactly, look at every picture yourself, and confirm the state with a command before you claim it.';
const B_BACKGROUND = '- Put long work in a background job and schedule follow-ups; never only promise them.';
const B_ASK = '- Ask the person you work for only what matters: a short numbered list, a recommendation for each. While an important question is open, do not build that part.';
const B_PRIVACY = '- Tell other agents only what their job needs: anything they keep in their memory can reach other conversations.';
const B_BACKWARDS = '- Never step backwards: a new version keeps what the old one did well.';
const B_OFFER = '- When the person you work for asks for something that splits into parts or needs a careful check, say in one line how your team would handle it and ask. If they decline that kind of job, do not offer it again.';
const B_CHALLENGER = '- Your challenger is the agent marked "challenger" among the platform workers listed to you (list_agents shows every agent you may consult). If there is none, ask a strong model from another vendor through spawn_workers.';

const SHARED_BULLETS_1 = [B_MODELS, B_BRIEFS, B_ONE_JOB, B_SECOND, B_REVIEW, B_JUDGE, B_CHECK, B_BACKGROUND, B_ASK, B_PRIVACY, B_BACKWARDS];

const FULL_TEXT = HEADING + FULL_INTRO + '\n' + [...SHARED_BULLETS_1, B_OFFER, B_CHALLENGER].join('\n');
const CORE_TEXT = HEADING + CORE_INTRO + '\n' + [...SHARED_BULLETS_1, B_CHALLENGER].join('\n');

const LIGHT_TEXT = HEADING + [
  'Do small jobs yourself; hand off big, parallel or long work.',
  '- Match the model to the job: cheap for lookups, mid-tier for routine work, the top tier only for planning and hard reviews.',
  '- Write briefs that stand alone.',
  '- One agent, one job.',
  '- Get a second opinion from a different model on anything important, and give the reviewer the work, not your conclusion.',
  '- Check the work before you rely on it.',
  '- Put long work in a background job.',
  '- Your challenger is the agent marked "challenger" among your platform workers; if there is none, use a strong model from another vendor through spawn_workers.',
].join('\n');

const SMALL_MODEL_PREFIXES = ['local/', 'lmstudio/', 'ollama/', 'omlx/', 'ninfer/'];
function isSmallModel(model) {
  const m = String(model || '').toLowerCase();
  return SMALL_MODEL_PREFIXES.some(p => m.startsWith(p));
}

/** The text for one agent ('' = none). `level` defaults to the hub setting. */
function textFor({ agent, isLead, level } = {}) {
  const a = agent && typeof agent === 'object' ? agent : {};
  let lv = level === undefined ? getLevel() : normalizeLevel(level);
  if (a.teamGuidance === 'off') return '';
  if (lv === 'off') {
    if (a.teamGuidance !== 'on') return '';
    lv = 'full';
  }
  if (lv === 'light' || a.minimalContext || isSmallModel(a.model)) return LIGHT_TEXT;
  return isLead ? FULL_TEXT : CORE_TEXT;
}

module.exports = { LEVELS, DEFAULT_LEVEL, AGENT_VALUES, normalizeLevel, getLevel, FULL_TEXT, CORE_TEXT, LIGHT_TEXT, isSmallModel, textFor };
