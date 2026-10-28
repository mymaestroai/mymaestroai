'use strict';

/**
 * scheduler.js — Scheduled Agent Task Runner
 *
 * Reads TASKS.md from each agent's workspace and executes tasks on schedule.
 * Supports three trigger types:
 *   1. Cron-based (e.g., "8:00 AM ET weekdays")
 *   2. Calendar-relative (e.g., "10 minutes before each meeting")
 *   3. Slack channel watch (e.g., "watch channel C0123456789 every 30 seconds")
 *      - Uses free Slack API pre-flight check; only burns LLM tokens when new messages exist
 *
 * Tasks are defined in natural language in each agent's TASKS.md file,
 * which the agent can also self-modify.
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const http = require('http');
const https = require('https');
const { notifyMeetingPrepReady, notifyMeetingImminent } = require('./sounds');
const { isAgentActive } = require('./sdk-chat');

const HUB_DIR = path.join(__dirname, '..');
const WORKSPACES_DIR = path.join(HUB_DIR, 'workspaces');
const TASK_LOG_DIR = path.join(HUB_DIR, 'data', 'task-logs');
const HUB_PORT = parseInt(process.env.PORT || '8888', 10);

// ── Slack Channel Watch (zero-cost pre-flight) ────────────────────────
// Stores last-seen message timestamp per channel to avoid LLM calls when idle

const SLACK_STATE_FILE = path.join(HUB_DIR, 'data', 'slack-watch-state.json');
let slackWatchState = {}; // { "C0123456789": "1715000000.000000" }
let slackWatchIntervals = []; // { id, agentName, channelId, interval }

function loadSlackWatchState() {
  try {
    if (fs.existsSync(SLACK_STATE_FILE)) {
      slackWatchState = JSON.parse(fs.readFileSync(SLACK_STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[scheduler] Failed to load slack watch state:', e.message);
    slackWatchState = {};
  }
}

function saveSlackWatchState() {
  try {
    fs.writeFileSync(SLACK_STATE_FILE, JSON.stringify(slackWatchState, null, 2));
  } catch (e) {
    console.error('[scheduler] Failed to save slack watch state:', e.message);
  }
}

/**
 * Check a Slack channel for new messages via direct API call.
 * Returns new messages (array) or empty array if nothing new.
 * Cost: ZERO LLM tokens - just a Slack Web API HTTP call.
 */
async function checkSlackChannelForNew(channelId) {
  const token = getSlackToken();
  if (!token) {
    console.error('[scheduler] No Slack token available for pre-flight check');
    return [];
  }

  const lastTs = slackWatchState[channelId] || null;
  const isFirstCheck = lastTs === null;

  return new Promise((resolve) => {
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channelId);
    if (lastTs) {
      url.searchParams.set('oldest', lastTs);
    }
    url.searchParams.set('limit', isFirstCheck ? '1' : '10');

    const req = https.get(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            console.error(`[scheduler] Slack API error for ${channelId}: ${parsed.error}`);
            resolve([]);
            return;
          }
          const msgs = parsed.messages || [];

          if (isFirstCheck) {
            // First boot: seed last-seen to latest message, fire nothing
            if (msgs.length > 0) {
              slackWatchState[channelId] = msgs[0].ts; // messages come newest-first
              saveSlackWatchState();
              console.log(`[scheduler] Slack watch ${channelId}: seeded last-seen to ${msgs[0].ts} (skipping old messages)`);
            }
            resolve([]);
            return;
          }

          // Filter out messages at or before lastTs
          const newMsgs = msgs.filter(m => m.ts > lastTs);
          if (newMsgs.length > 0) {
            // Update last-seen to the newest message timestamp
            const maxTs = newMsgs.reduce((max, m) => m.ts > max ? m.ts : max, lastTs);
            slackWatchState[channelId] = maxTs;
            saveSlackWatchState();
          }
          resolve(newMsgs);
        } catch (e) {
          console.error('[scheduler] Failed to parse Slack response:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.error(`[scheduler] Slack pre-flight error for ${channelId}:`, e.message);
      resolve([]);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

/**
 * Get the Slack xoxp token from the standard location.
 */
function getSlackToken() {
  try {
    const tokenPath = path.join(process.env.HOME || '', '.config', 'slack-mcp', 'token');
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, 'utf8').trim();
    }
  } catch (e) {
    // silent
  }
  return process.env.SLACK_TOKEN || null;
}

// ── State ──────────────────────────────────────────────────────────────

let activeCronJobs = [];        // { id, agentName, job }
let calendarPollInterval = null;
let meetingAlertInterval = null; // 1-minute-before-meeting alerts
let preparedMeetings = new Set(); // dedup: "agentName:eventId" keys
let alertedMeetings = new Set(); // dedup for 1-min alerts: "eventId" keys
let lastCalendarCheck = 0;

// ── TASKS.md Parser ────────────────────────────────────────────────────

/**
 * Parse TASKS.md into structured task objects.
 *
 * Expected format:
 * ### task-name
 * - **trigger:** 10 minutes before each meeting
 * - **action:** Generate a meeting prep doc and DM me on Slack
 * - **exclude:** Focus Time, OOO, 1-person events
 * - **enabled:** true
 */
function parseTasksFile(content) {
  const tasks = [];
  const taskBlocks = content.split(/^### /gm).filter(Boolean);

  for (const block of taskBlocks) {
    const lines = block.trim().split('\n');
    const id = lines[0].trim();
    const task = { id, properties: {} };

    let currentKey = null;
    for (const line of lines.slice(1)) {
      // Matches both "- **key:** value" and "- **key**: value"
      const match = line.match(/^-\s+\*\*([^*:]+):?\*\*:?\s*(.*)$/i);
      if (match) {
        currentKey = match[1].trim().toLowerCase();
        const value = match[2].trim();
        task.properties[currentKey] = value;
      } else if (currentKey && line.trim()) {
        // Continuation line for the current key (multiline values)
        task.properties[currentKey] += '\n' + line.trim();
      }
    }

    if (task.properties.action) {
      tasks.push({
        id,
        trigger: task.properties.trigger || task.properties.schedule || '',
        action: task.properties.action,
        exclude: task.properties.exclude || '',
        enabled: (task.properties.enabled || 'true').toLowerCase() === 'true',
      });
    }
  }

  return tasks;
}

/**
 * Load TASKS.md for a specific agent.
 */
function loadAgentTasks(agentName) {
  const tasksPath = path.join(WORKSPACES_DIR, agentName, 'TASKS.md');
  if (!fs.existsSync(tasksPath)) return [];

  try {
    const content = fs.readFileSync(tasksPath, 'utf8');
    return parseTasksFile(content);
  } catch (e) {
    console.error(`[scheduler] Error reading TASKS.md for ${agentName}:`, e.message);
    return [];
  }
}

/**
 * Load tasks for ALL agents.
 */
function loadAllTasks() {
  const allTasks = [];
  if (!fs.existsSync(WORKSPACES_DIR)) return allTasks;

  const agents = fs.readdirSync(WORKSPACES_DIR).filter(f =>
    fs.statSync(path.join(WORKSPACES_DIR, f)).isDirectory()
  );

  for (const agentName of agents) {
    const tasks = loadAgentTasks(agentName);
    for (const task of tasks) {
      allTasks.push({ ...task, agentName });
    }
  }

  return allTasks;
}

// ── Trigger Classification ─────────────────────────────────────────────

/**
 * Determine if a trigger is calendar-relative, slack-watch, or cron-based.
 */
function classifyTrigger(trigger) {
  const lower = trigger.toLowerCase();

  // Slack channel watch triggers: "watch channel C0123456789 [every N seconds]"
  const slackMatch = lower.match(/watch\s+channel\s+([A-Z0-9]+)(?:\s+every\s+(\d+)\s*sec)?/i);
  if (slackMatch) {
    return {
      type: 'slack-watch',
      channelId: slackMatch[1].toUpperCase(),
      intervalSeconds: slackMatch[2] ? parseInt(slackMatch[2]) : 30,
    };
  }

  // Calendar-relative triggers
  if (lower.includes('before each meeting') ||
      lower.includes('before every meeting') ||
      lower.includes('before each calendar') ||
      lower.includes('minutes before') ||
      lower.includes('before meetings')) {
    const minuteMatch = lower.match(/(\d+)\s*minutes?\s*before/);
    return {
      type: 'calendar',
      minutesBefore: minuteMatch ? parseInt(minuteMatch[1]) : 10,
    };
  }

  // Cron-based triggers — parse natural language to cron expression. Times that name ET/Eastern
  // run in America/New_York (DST-aware); others in the box's local zone.
  return {
    type: 'cron',
    expression: naturalLanguageToCron(trigger),
    timezone: /\b(et|est|edt|eastern)\b/.test(lower) ? 'America/New_York' : undefined,
  };
}

/**
 * Convert natural language schedule to cron expression.
 */
function naturalLanguageToCron(text) {
  const lower = text.toLowerCase();

  // Interval patterns: "every N minutes", "every N hours", "every hour"
  const everyMinMatch = lower.match(/every\s+(\d+)\s*min/);
  if (everyMinMatch) {
    const mins = parseInt(everyMinMatch[1]);
    return `*/${mins} * * * *`;
  }

  const everyHourMatch = lower.match(/every\s+(\d+)\s*hour/);
  if (everyHourMatch) {
    const hrs = parseInt(everyHourMatch[1]);
    return `0 */${hrs} * * *`;
  }

  if (lower.includes('every hour') || lower === 'hourly') {
    return '0 * * * *';
  }

  // Extract time (e.g., "8:00 AM", "9:30 PM")
  const timeMatch = lower.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)/);
  let hour = 0, minute = 0;
  if (timeMatch) {
    hour = parseInt(timeMatch[1]);
    minute = parseInt(timeMatch[2] || '0');
    if (timeMatch[3] === 'pm' && hour !== 12) hour += 12;
    if (timeMatch[3] === 'am' && hour === 12) hour = 0;
  }

  // No UTC shift here: node-cron evaluates in local time (or the trigger's timezone, see
  // classifyTrigger). The old "+4 h for ET" made "8:15 PM ET" fire at 00:15 ET on a box that
  // already runs on Eastern time (and matched any "et" substring, e.g. "meeting").

  // Day of week
  let dayOfWeek = '*';
  if (lower.includes('weekday') || lower.includes('mon-fri') || lower.includes('monday through friday')) {
    dayOfWeek = '1-5';
  } else if (lower.includes('monday')) dayOfWeek = '1';
  else if (lower.includes('tuesday')) dayOfWeek = '2';
  else if (lower.includes('wednesday')) dayOfWeek = '3';
  else if (lower.includes('thursday')) dayOfWeek = '4';
  else if (lower.includes('friday')) dayOfWeek = '5';

  return `${minute} ${hour} * * ${dayOfWeek}`;
}

// ── Calendar Polling ───────────────────────────────────────────────────

/**
 * Check calendar for upcoming meetings and fire prep tasks.
 * Called every 5 minutes.
 */
async function pollCalendar() {
  const allTasks = loadAllTasks();
  const calendarTasks = allTasks.filter(t =>
    t.enabled && classifyTrigger(t.trigger).type === 'calendar'
  );

  if (calendarTasks.length === 0) return;

  console.log(`[scheduler] Polling calendar for ${calendarTasks.length} calendar-triggered task(s)...`);

  // Get upcoming events for the next 30 minutes
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 30 * 60 * 1000);

  let events;
  try {
    events = await getUpcomingCalendarEvents(now, windowEnd);
  } catch (e) {
    console.error('[scheduler] Failed to fetch calendar events:', e.message);
    return;
  }

  if (!events || events.length === 0) return;

  for (const task of calendarTasks) {
    const { minutesBefore } = classifyTrigger(task.trigger);
    const excludePatterns = parseExcludePatterns(task.exclude);

    for (const event of events) {
      // Skip if already prepped
      const dedupKey = `${task.agentName}:${task.id}:${event.id}`;
      if (preparedMeetings.has(dedupKey)) continue;

      // Skip excluded event types
      if (shouldExcludeEvent(event, excludePatterns)) continue;

      // Check if it's time to fire (within the prep window)
      const eventStart = new Date(event.start?.dateTime || event.start?.date);
      const fireTime = new Date(eventStart.getTime() - minutesBefore * 60 * 1000);
      const fireWindowEnd = new Date(fireTime.getTime() + 6 * 60 * 1000); // 6-min window

      if (now >= fireTime && now <= fireWindowEnd) {
        console.log(`[scheduler] Firing task "${task.id}" for meeting "${event.summary}" (starts ${eventStart.toLocaleTimeString()})`);
        preparedMeetings.add(dedupKey);

        // Build a context-rich prompt for the agent
        const prompt = buildMeetingPrepPrompt(task, event);
        await executeAgentTask(task.agentName, task.id, prompt);
      }
    }
  }

  // Clean old dedup entries (meetings from yesterday)
  cleanPreparedMeetings();
}

/**
 * Parse exclude patterns from the exclude string.
 */
function parseExcludePatterns(excludeStr) {
  if (!excludeStr) return [];
  return excludeStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Determine if an event should be excluded from prep.
 */
function shouldExcludeEvent(event, excludePatterns) {
  const summary = (event.summary || '').toLowerCase();
  const eventType = (event.eventType || '').toLowerCase();
  const attendees = event.attendees || [];
  const selfResponse = attendees.find(a => a.self)?.responseStatus;

  // Must be accepted — skip tentative, declined, needsAction
  if (selfResponse && selfResponse !== 'accepted') return true;

  // Skip events with no other attendees (solo blocks, reminders)
  const otherAttendees = attendees.filter(a => !a.self && !a.resource);
  if (otherAttendees.length === 0) return true;

  // Skip all-day events (likely OOO, holidays, travel)
  if (event.start?.date && !event.start?.dateTime) return true;

  // Skip Focus Time, OOO, Working Location event types
  if (['outofoffice', 'focustime', 'workinglocation'].includes(eventType)) return true;
  if (eventType === 'outOfOffice' || eventType === 'focusTime' || eventType === 'workingLocation') return true;

  // Skip based on exclude patterns
  for (const pattern of excludePatterns) {
    if (summary.includes(pattern)) return true;
  }

  // Skip travel-related events
  const travelPatterns = ['flight', 'hotel', 'check-in', 'checkout', 'check in',
    'check out', 'travel', 'layover', 'boarding', 'departure', 'arrival',
    'reservation', 'airbnb', 'uber', 'lyft', 'rental car'];
  for (const pattern of travelPatterns) {
    if (summary.includes(pattern)) return true;
  }

  // Skip events that are likely holds/blocks
  const holdPatterns = ['hold', 'block', 'busy', 'commute', 'lunch', 'break',
    'personal', 'gym', 'workout', 'dentist', 'doctor', 'appointment'];
  for (const pattern of holdPatterns) {
    if (summary === pattern) return true; // exact match only for these
  }

  return false;
}

/**
 * Build a rich prompt for meeting prep.
 */
function buildMeetingPrepPrompt(task, event) {
  const start = new Date(event.start?.dateTime || event.start?.date);
  const attendees = (event.attendees || [])
    .filter(a => !a.self && !a.resource)
    .map(a => a.email || a.displayName)
    .join(', ');

  const description = event.description || 'No description provided.';
  const location = event.location || event.hangoutLink || 'No location specified';

  return `SCHEDULED TASK: ${task.action}

Meeting Details:
- **Title:** ${event.summary}
- **Time:** ${start.toLocaleString('en-US', { timeZone: require('./timezone').hubZone(), weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}
- **Attendees:** ${attendees || 'None listed'}
- **Location:** ${location}
- **Description/Agenda:** ${description}
${event.htmlLink ? `- **Calendar Link:** ${event.htmlLink}` : ''}

Instructions: Generate a thorough meeting prep document. Look up any linked documents or pre-reads in the description. Research the attendees and topics. Send the prep to me as a Slack DM (my user ID is process.env.SLACK_USER_ID || 'YOUR_SLACK_USER_ID'). Format it well — include agenda analysis, key questions, attendee context, and any background research.`;
}

/**
 * Fetch upcoming calendar events using the Google Workspace MCP.
 */
async function getUpcomingCalendarEvents(start, end) {
  const { executeMcpTool } = require('./skills/skill-manager');

  const timeMin = start.toISOString();
  const timeMax = end.toISOString();

  try {
    const result = await executeMcpTool(
      'google-workspace',
      'list_calendar_events',
      {
        timeMin,
        timeMax,
        singleEvents: true,
      }
    );

    if (!result) {
      console.error('[scheduler] Calendar MCP returned empty result');
      return [];
    }

    // executeMcpTool returns a string (joined text content)
    try {
      const data = JSON.parse(result);
      return data.events || data.items || [];
    } catch {
      console.warn('[scheduler] Could not parse calendar response as JSON');
      return [];
    }
  } catch (e) {
    console.error('[scheduler] Calendar fetch error:', e.message);
    return [];
  }
}

// ── Task Execution ─────────────────────────────────────────────────────

/**
 * Execute a task by sending the prompt to the agent via the Hub's chat API.
 */
// TASKS.md prompts are saved in the agent's chat like any turn: mark them so neither the
// owner reading history nor the agent mistakes them for something the owner typed.
function tasksMdMessage(taskId, prompt, now = new Date(), zone = 'UTC') {   // zone: the hub's (lib/timezone), from the caller
  const at = now.toLocaleString('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `[Scheduled task — started by the hub scheduler from TASKS.md, NOT a message typed by the owner] "${taskId}", run ${at}.\n\nTask:\n${prompt}`;
}

async function executeAgentTask(agentName, taskId, prompt) {
  // Hub kill switch: a halted hub fires nothing
  if (require('./hub-halt').getHubHalt().isHalted()) {
    console.log(`[scheduler] Task "${taskId}" for "${agentName}" skipped: hub halted`);
    writeTaskLog({ timestamp: new Date().toISOString(), agent: agentName, taskId, prompt: String(prompt || '').slice(0, 200), status: 'skipped: hub halted' });
    return;
  }
  // Hard guard: never spawn a second instance if the agent is already active
  if (isAgentActive(agentName)) {
    console.log(`[scheduler] Skipping task "${taskId}" — agent "${agentName}" is already active`);
    return;
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    agent: agentName,
    taskId,
    prompt: prompt.slice(0, 200) + '...',
    status: 'running',
  };

  console.log(`[scheduler] Executing task "${taskId}" via agent "${agentName}"`);
  const message = tasksMdMessage(taskId, prompt, new Date(), require('./timezone').hubZone());

  try {
    const response = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        agent: agentName,
        message,
        origin: { kind: 'schedule', from: taskId },   // hub event stream: open windows see the task run live
        // No ephemeral flag — task activity saves to conversation history
        // so it's visible when the user opens the agent's chat
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port: HUB_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: {
          [require('./auth').SERVICE_HEADER]: require('./auth').SERVICE_TOKEN,   // the hub calling itself
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 300000, // 5 min timeout for task execution
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Task execution timed out (5m)'));
      });
      req.write(body);
      req.end();
    });

    if (response.status === 409) {
      // The hub refused the turn because the agent was mid-turn. Nothing ran.
      logEntry.status = 'skipped-busy';
      logEntry.error = 'agent busy';
      console.warn(`[scheduler] Task "${taskId}" skipped: agent "${agentName}" is busy (409); it will run at its next scheduled time`);
      writeTaskLog(logEntry);
      return;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`hub refused the turn (${response.status}): ${String(response.data).slice(0, 200)}`);
    }
    logEntry.status = 'completed';
    logEntry.responseLength = response.data.length;
    console.log(`[scheduler] Task "${taskId}" completed (${response.data.length} chars)`);

    // Play sound if this was a meeting prep task
    if (prompt.includes('SCHEDULED TASK') && prompt.includes('Meeting Details')) {
      notifyMeetingPrepReady().catch(e => console.error('[scheduler] Sound error:', e.message));
    }
  } catch (e) {
    logEntry.status = 'failed';
    logEntry.error = e.message;
    console.error(`[scheduler] Task "${taskId}" failed:`, e.message);
  }

  // Log the result
  writeTaskLog(logEntry);
}

// ── Task Logging ───────────────────────────────────────────────────────

function writeTaskLog(entry) {
  if (!fs.existsSync(TASK_LOG_DIR)) {
    fs.mkdirSync(TASK_LOG_DIR, { recursive: true });
  }

  const date = new Date().toISOString().split('T')[0];
  const logFile = path.join(TASK_LOG_DIR, `${date}.jsonl`);

  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[scheduler] Failed to write task log:', e.message);
  }
}

function getTaskLogs(date) {
  const logFile = path.join(TASK_LOG_DIR, `${date}.jsonl`);
  if (!fs.existsSync(logFile)) return [];

  try {
    return fs.readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (e) {
    return [];
  }
}

// ── 1-Minute Meeting Alerts ───────────────────────────────────────────

/**
 * Check for meetings starting in ~1 minute and play an alert sound.
 * Runs every 30 seconds for precision.
 */
async function checkMeetingAlerts() {
  const now = new Date();
  // Window is 30s→180s ahead (150s wide) so a 60s poll interval can never
  // let a meeting slip between ticks.  alertedMeetings dedupes repeat hits.
  const oneMinFromNow = new Date(now.getTime() + 30 * 1000);
  const twoMinFromNow = new Date(now.getTime() + 3 * 60 * 1000);

  let events;
  try {
    events = await getUpcomingCalendarEvents(oneMinFromNow, twoMinFromNow);
  } catch (e) {
    // Silent fail — don't spam logs every poll
    return;
  }

  if (!events || events.length === 0) return;

  for (const event of events) {
    // Skip if already alerted
    if (alertedMeetings.has(event.id)) continue;

    // Skip non-meeting events
    const eventType = (event.eventType || '').toLowerCase();
    if (['outofoffice', 'focustime', 'workinglocation'].includes(eventType)) continue;
    if (event.start?.date && !event.start?.dateTime) continue; // all-day

    // Skip events with no attendees (solo blocks)
    const attendees = event.attendees || [];
    const otherAttendees = attendees.filter(a => !a.self && !a.resource);
    if (otherAttendees.length === 0) continue;

    // Skip declined/tentative
    const selfResponse = attendees.find(a => a.self)?.responseStatus;
    if (selfResponse && selfResponse !== 'accepted') continue;

    // Fire the alert!
    alertedMeetings.add(event.id);
    const title = event.summary || 'Unnamed meeting';
    console.log(`[scheduler] 🚨 1 minute until: "${title}"`);
    notifyMeetingImminent(title).catch(e => console.error('[scheduler] Alert sound error:', e.message));
  }
}

// ── Dedup Cleanup ──────────────────────────────────────────────────────

function cleanPreparedMeetings() {
  // Reset dedup sets at midnight (keep them bounded)
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() < 6) {
    preparedMeetings.clear();
    alertedMeetings.clear();
  }
}

// ── Scheduler Lifecycle ────────────────────────────────────────────────

/**
 * Initialize the scheduler — set up cron jobs and calendar polling.
 */
function startScheduler() {
  console.log('[scheduler] Starting scheduler...');
  stopScheduler(); // Clean slate
  loadSlackWatchState(); // Load last-seen timestamps

  const allTasks = loadAllTasks();
  if (allTasks.length === 0) {
    console.log('[scheduler] No tasks found in any agent TASKS.md');
    return;
  }

  let cronCount = 0;
  let calendarCount = 0;
  let slackWatchCount = 0;

  for (const task of allTasks) {
    if (!task.enabled) continue;

    const trigger = classifyTrigger(task.trigger);

    if (trigger.type === 'slack-watch') {
      // Zero-cost Slack channel watch - direct API pre-flight, LLM only on new messages
      const { channelId, intervalSeconds } = trigger;
      const interval = setInterval(async () => {
        // Skip if agent is already processing
        if (isAgentActive(task.agentName)) {
          return;
        }

        const newMsgs = await checkSlackChannelForNew(channelId);
        if (newMsgs.length === 0) return; // Nothing new - zero tokens burned

        console.log(`[scheduler] Slack watch: ${newMsgs.length} new message(s) in ${channelId} - firing "${task.id}" (agent: ${task.agentName})`);

        // Build context with the new messages so the agent knows what's new
        const msgSummaries = newMsgs.map(m => {
          const user = m.user || 'unknown';
          const text = (m.text || '').slice(0, 500);
          const ts = m.ts;
          return `- [${ts}] <@${user}>: ${text}`;
        }).join('\n');

        const prompt = `SCHEDULED TASK: ${task.action}\n\nNEW MESSAGES DETECTED (${newMsgs.length}):\n${msgSummaries}`;
        await executeAgentTask(task.agentName, task.id, prompt);
      }, intervalSeconds * 1000);

      slackWatchIntervals.push({ id: task.id, agentName: task.agentName, channelId, interval });
      slackWatchCount++;
      console.log(`[scheduler] Registered slack-watch "${task.id}" on channel ${channelId} (every ${intervalSeconds}s) for agent "${task.agentName}"`);

    } else if (trigger.type === 'cron' && trigger.expression) {
      try {
        if (!cron.validate(trigger.expression)) {
          console.warn(`[scheduler] Invalid cron for "${task.id}": ${trigger.expression}`);
          continue;
        }

        const job = cron.schedule(trigger.expression, async () => {
          console.log(`[scheduler] Cron fired for "${task.id}" (agent: ${task.agentName})`);
          await executeAgentTask(task.agentName, task.id, `SCHEDULED TASK: ${task.action}`);
        }, trigger.timezone ? { timezone: trigger.timezone } : undefined);

        activeCronJobs.push({ id: task.id, agentName: task.agentName, job });
        cronCount++;
        console.log(`[scheduler] Registered cron task "${task.id}" (${trigger.expression}${trigger.timezone ? ' ' + trigger.timezone : ''}) for agent "${task.agentName}"`);
      } catch (e) {
        console.error(`[scheduler] Failed to register cron "${task.id}":`, e.message);
      }
    } else if (trigger.type === 'calendar') {
      calendarCount++;
    }
  }

  // Start calendar polling if any calendar-triggered tasks exist
  if (calendarCount > 0) {
    console.log(`[scheduler] ${calendarCount} calendar-triggered task(s) — starting calendar poll (every 5 min)`);
    calendarPollInterval = setInterval(pollCalendar, 5 * 60 * 1000);

    // Run first poll after a short delay (let MCP skills initialize)
    setTimeout(pollCalendar, 30 * 1000);
  }

  // Always start 1-minute meeting alerts (every 30 seconds)
  console.log('[scheduler] Starting 1-minute meeting alerts (every 30s)');
  meetingAlertInterval = setInterval(checkMeetingAlerts, 60 * 1000); // 60s poll + 150s-wide window in checkMeetingAlerts — was 30s, which flooded the calendar MCP and server.log
  // First check after 15s
  setTimeout(checkMeetingAlerts, 15 * 1000);

  console.log(`[scheduler] Started: ${cronCount} cron job(s), ${calendarCount} calendar-triggered task(s), ${slackWatchCount} slack-watch(es), meeting alerts ON`);
}

/**
 * Stop the scheduler — clear all jobs and intervals.
 */
function stopScheduler() {
  for (const { id, job } of activeCronJobs) {
    job.stop();
  }
  activeCronJobs = [];

  // Stop Slack watch intervals
  for (const { interval } of slackWatchIntervals) {
    clearInterval(interval);
  }
  slackWatchIntervals = [];

  if (calendarPollInterval) {
    clearInterval(calendarPollInterval);
    calendarPollInterval = null;
  }

  if (meetingAlertInterval) {
    clearInterval(meetingAlertInterval);
    meetingAlertInterval = null;
  }

  preparedMeetings.clear();
  alertedMeetings.clear();
}

/**
 * Reload tasks from disk (call after TASKS.md is modified).
 */
function reloadScheduler() {
  console.log('[scheduler] Reloading tasks...');
  startScheduler();
}

/**
 * Get scheduler status for API/UI.
 */
function getSchedulerStatus() {
  const allTasks = loadAllTasks();
  return {
    running: activeCronJobs.length > 0 || calendarPollInterval !== null || slackWatchIntervals.length > 0,
    cronJobs: activeCronJobs.map(j => ({ id: j.id, agent: j.agentName })),
    slackWatches: slackWatchIntervals.map(w => ({ id: w.id, agent: w.agentName, channel: w.channelId })),
    calendarPolling: calendarPollInterval !== null,
    tasks: allTasks.map(t => {
      const c = classifyTrigger(t.trigger);
      return {
        id: t.id,
        agent: t.agentName,
        trigger: t.trigger,
        triggerType: c.type,
        expression: c.expression,
        timezone: c.timezone,
        action: t.action.slice(0, 100),
        enabled: t.enabled,
      };
    }),
  };
}

// ── Exports ────────────────────────────────────────────────────────────

module.exports = {
  classifyTrigger,
  naturalLanguageToCron,
  startScheduler,
  stopScheduler,
  reloadScheduler,
  getSchedulerStatus,
  getTaskLogs,
  loadAgentTasks,
  loadAllTasks,
  executeAgentTask,
};
