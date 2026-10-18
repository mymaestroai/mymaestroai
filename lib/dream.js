'use strict';

/**
 * dream.js — Agent Dreaming System
 *
 * Allows agents to "dream" — reviewing their recent activity, tool-learning errors,
 * and session notes to consolidate learnings into long-term memory.
 *
 * Uses Sonnet for genuine synthesis (not just summarization).
 * Supports both API gateway and Claude SDK (for users without API keys).
 * Manual trigger only — no autonomous scheduling.
 *
 * High-water mark: tracks `last_dreamed_at` per agent so notes are never
 * re-processed.  First run looks back 60 days; subsequent runs only process
 * notes newer than the watermark.
 */

const fs = require('fs');
const path = require('path');
const { chatCompletion } = require('./gateway-client');
const {
  readLongTermMemory,
  writeLongTermMemory,
  readSessionNotes,
  appendLongTermMemory,
} = require('./memory-db');
const { getRecentErrors } = require('./tool-learning');

// Preferred models in order of preference
const DREAM_MODELS = ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
const LOOKBACK_DAYS = 60; // Max lookback on first dream (no watermark)

// Credential detection lives in lib/claude-auth.js (file, Keychain, or CLI).
const { hasSdkCredentials } = require('./claude-auth');

function hasApiKey() {
  return !!require('./settings').getProviderKey('anthropic');
}

// SDK-based completion (for users without API keys)
const { loadSdk, cliOptions } = require('./sdk-loader');
async function sdkCompletion(prompt, model) {
  const sdkModule = await loadSdk();

  let result = '';
  const queryIterator = sdkModule.query({
    prompt,
    options: {
      model,
      maxTurns: 1,
      permissionMode: 'acceptEdits',
      tools: [],  // No tools needed for dreaming
      ...cliOptions(),
    },
  });

  for await (const msg of queryIterator) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          result += block.text;
        }
      }
    }
    if (msg.type === 'result' && msg.text) {
      result = msg.text;
    }
  }

  return result;
}

// Unified completion function — tries API first, falls back to SDK
async function dreamCompletion(prompt) {
  // Try API gateway first (faster, cheaper)
  if (hasApiKey()) {
    for (const model of DREAM_MODELS) {
      try {
        const response = await chatCompletion(
          [{ role: 'user', content: prompt }],
          { model, max_tokens: 1000, temperature: 0.3 }
        );
        return response?.choices?.[0]?.message?.content?.trim() || '';
      } catch (e) {
        // Model not available, try next
        continue;
      }
    }
  }

  // Fall back to SDK
  if (hasSdkCredentials()) {
    for (const model of DREAM_MODELS) {
      try {
        return await sdkCompletion(prompt, model);
      } catch (e) {
        // Model not available, try next
        continue;
      }
    }
  }

  throw new Error('No LLM available for dreaming. Need either ANTHROPIC_API_KEY or Claude SDK credentials.');
}

// ── State ──────────────────────────────────────────────────────────────────

let dreamState = {
  status: 'idle',       // idle | running | complete | error
  startedAt: null,
  completedAt: null,
  currentAgent: null,
  results: [],          // { agent, learnings, skipped? }
  error: null,
};

function getDreamStatus() {
  return { ...dreamState };
}

// ── Watermark Management ──────────────────────────────────────────────────

/**
 * Read the high-water mark (last_dreamed_at) from the agent's dreams section.
 * Format: first line is `<!-- watermark:YYYY-MM-DD -->` (hidden from LLM display).
 */
function getWatermark(agent) {
  const dreams = readLongTermMemory(agent, 'dreams');
  if (!dreams) return null;
  const match = dreams.match(/^<!-- watermark:(\d{4}-\d{2}-\d{2}) -->/);
  return match ? match[1] : null;
}

/**
 * Update the watermark in the agent's dreams section.
 * Preserves all existing dream content after the watermark line.
 */
function setWatermark(agent, date) {
  const dreams = readLongTermMemory(agent, 'dreams') || '';
  // Strip existing watermark if present
  const content = dreams.replace(/^<!-- watermark:\d{4}-\d{2}-\d{2} -->\n?/, '');
  const newContent = `<!-- watermark:${date} -->\n${content}`;
  writeLongTermMemory(agent, newContent, 'dreams');
}

// ── Date Helpers ──────────────────────────────────────────────────────────

function getDatesInRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// ── Dream Prompt ───────────────────────────────────────────────────────────

function buildDreamPrompt(agent, sessionNotes, toolErrors, existingMemory) {
  return `You are an introspection engine for an AI agent called "${agent}".

Your job: review this agent's recent activity and extract ACTIONABLE learnings that will make the agent better at its job tomorrow.

## What to produce:
- Behavioral patterns (what works, what doesn't)
- Tool usage insights (better approaches discovered, common pitfalls)
- Domain knowledge gained (facts, relationships, architecture)
- User preference signals (formatting, depth, style)
- Mistakes to avoid (with specific corrections)
- Heuristics and shortcuts discovered

## Rules:
- Only output genuinely NEW insights not already in existing memory
- Be specific and actionable — not vague platitudes
- If nothing meaningful was learned, say "NO_NEW_LEARNINGS" and nothing else
- Keep each learning to 1-2 sentences max
- Format as a bullet list (- prefix)
- Maximum 10 learnings per dream session

## Recent Activity:
${sessionNotes || '(no recent activity)'}

## Recent Tool Errors:
${toolErrors || '(none)'}

## Existing Long-Term Memory (avoid duplicating):
${existingMemory ? existingMemory.slice(0, 2000) : '(empty)'}

Output ONLY the bullet list of new learnings (or NO_NEW_LEARNINGS):`;
}

// ── Core Dream Function ────────────────────────────────────────────────────

async function dreamForAgent(agent) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Determine start date from watermark (or 60 days ago on first run)
  const watermark = getWatermark(agent);
  let startDate;
  if (watermark) {
    // Start from day AFTER last dream
    const wm = new Date(watermark);
    wm.setDate(wm.getDate() + 1);
    startDate = wm.toISOString().slice(0, 10);
  } else {
    // First dream ever — look back 60 days
    const past = new Date(now - LOOKBACK_DAYS * 86400000);
    startDate = past.toISOString().slice(0, 10);
  }

  // If watermark is today or later, nothing new to process
  if (startDate > today) {
    return { agent, skipped: true, reason: 'already dreamed today' };
  }

  // Gather all session notes in range
  const dates = getDatesInRange(startDate, today);
  let sessionNotes = '';
  let notesFound = 0;

  for (const date of dates) {
    const notes = readSessionNotes(agent, date);
    if (notes && !notes.startsWith('(no session')) {
      // Trim individual day notes to keep total manageable
      const trimmed = notes.length > 800 ? notes.slice(0, 800) + '...' : notes;
      sessionNotes += `### ${date}\n${trimmed}\n\n`;
      notesFound++;
    }
  }

  // Skip agents with no activity in the range
  if (notesFound === 0) {
    return { agent, skipped: true, reason: 'no activity since last dream' };
  }

  // Cap total session notes to avoid token explosion
  if (sessionNotes.length > 12000) {
    sessionNotes = sessionNotes.slice(-12000);
  }

  // Gather recent tool errors
  let toolErrors = '';
  try {
    const errors = getRecentErrors(20);
    const agentErrors = errors.filter(e =>
      e.agent === agent || !e.agent
    ).slice(0, 10);
    if (agentErrors.length > 0) {
      toolErrors = agentErrors.map(e =>
        `- ${e.tool_name}: ${e.error_message?.slice(0, 150)}`
      ).join('\n');
    }
  } catch {}

  // Get existing memory to avoid duplication
  const existingMemory = readLongTermMemory(agent);

  // Build prompt and call LLM (API or SDK)
  const prompt = buildDreamPrompt(agent, sessionNotes, toolErrors, existingMemory);
  const output = await dreamCompletion(prompt);

  if (!output || output === 'NO_NEW_LEARNINGS') {
    // Still update watermark so we don't re-process these notes
    setWatermark(agent, today);
    return { agent, skipped: true, reason: 'no new learnings' };
  }

  // Save learnings to agent's long-term memory
  const entry = `\n## Dream — ${today}\n${output}`;
  appendLongTermMemory(agent, entry, 'dreams');

  // Update watermark
  setWatermark(agent, today);

  return { agent, learnings: output, skipped: false, daysProcessed: notesFound };
}

// ── Run All Agents ─────────────────────────────────────────────────────────

// Agents to skip during dreaming (workers, test, noTools, etc.)
const SKIP_AGENTS = new Set([
  'haiku', 'worker', 'qwen', 'sanitizer', 'tester1', 'tester2',
  'test', 'mythosworker1', 'mythosworker2', 'mythosworker3',
  'ghostwriter', 'open', 'gemini',
]);

async function runDreamCycle(agents) {
  if (dreamState.status === 'running') {
    throw new Error('Dream cycle already in progress');
  }

  dreamState = {
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    currentAgent: null,
    results: [],
    error: null,
  };

  const eligible = agents.filter(a => !SKIP_AGENTS.has(a.name));

  try {
    for (const agent of eligible) {
      dreamState.currentAgent = agent.name;
      try {
        const result = await dreamForAgent(agent.name);
        dreamState.results.push(result);
      } catch (err) {
        dreamState.results.push({
          agent: agent.name,
          skipped: true,
          reason: `error: ${err.message?.slice(0, 100)}`,
        });
      }
    }

    dreamState.status = 'complete';
    dreamState.completedAt = new Date().toISOString();
    dreamState.currentAgent = null;
  } catch (err) {
    dreamState.status = 'error';
    dreamState.error = err.message;
    dreamState.currentAgent = null;
  }

  return dreamState;
}

module.exports = {
  runDreamCycle,
  getDreamStatus,
};
