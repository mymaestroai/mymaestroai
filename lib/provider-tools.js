'use strict';

/**
 * provider-tools.js — Tool support for multi-provider LLM routing (OpenAI-compatible).
 *
 * Built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch)
 * in OpenAI function-calling format. Executes tool calls and manages the multi-turn tool loop.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { preserve } = require('./tiger-team-artifacts');
let _defaultHubTools = null;
const defaultHubTools = () => _defaultHubTools || (_defaultHubTools = require('./hub-tools').createHubTools({ preserve }));
// No external glob dependency — use shell-based approach

// ── Built-in Tool Definitions ───────────────────────────────────────────

const BUILTIN_TOOLS = {
  // Bash, Read, Write, Edit, Glob, Grep: the hub's own hands (lib/hub-tools), one implementation for every model
  // path. These module-level entries run on the host in the hub's cwd with string results; the gateway tool loop
  // (lib/sdk-chat buildAllTools) replaces the handlers per turn with an instance that knows the agent's sandbox,
  // working directory and read registry and carries images (PDF pages, image files) back to the model.
  ...Object.fromEntries(Object.entries(require('./hub-tools').SPECS).map(([name, spec]) => [name, {
    description: spec.description,
    parameters: spec.parameters,
    handler: async (args) => {
      const r = await defaultHubTools().call(name, args || {});
      return r.images && r.images.length ? `${r.text}\n(${r.images.length} image(s) could not be shown on this path)` : r.text;
    },
  }])),

  WebSearch: {
    description: 'Search the web. One tool for every agent and model: the hub walks its configured search backends (Brave, Perplexity, Serper, Tavily, a self-hosted SearXNG, DuckDuckGo) in the owner\'s order and returns the first that answers: rank, title, URL, date when known, snippet, and which backend answered. Name a backend only when you need that one (e.g. perplexity for cited, fresh results).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        max_results: { type: 'number', description: 'Maximum number of results to return (default: 10, max: 25)' },
        freshness: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Only results from the last day/week/month/year (where the backend supports it)' },
        backend: { type: 'string', enum: ['brave', 'perplexity', 'serper', 'tavily', 'searxng', 'duckduckgo'], description: 'Use this one backend instead of the chain (must be configured on this hub)' },
      },
      required: ['query'],
    },
    handler: async ({ query, max_results, freshness, backend }) => {
      try {
        const ws = require('./web-search').getWebSearch();
        const r = await ws.search(query, { maxResults: max_results, freshness, backend });
        const rendered = ws.render(r);
        preserve(rendered, `WebSearch:${query}`);
        return rendered;
      } catch (e) {
        if (e && e.code === 'TT_PERSISTENCE_FAILED') throw e;
        return `Search error: ${e.message}`;
      }
    },
  },

  WebFetch: {
    description: 'Fetch a web page and return it as markdown with its headings, links, lists, tables and code kept, so you can read it and follow links you find. Reads PDFs (text) and plain text/JSON too. Pages that need JavaScript are rendered in a browser automatically when the plain fetch is empty, or on request with render: true. Long pages are paged with offset. Private and local addresses are refused unless this hub allows them for your agent.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch (http or https)' },
        max_length: { type: 'number', description: 'Maximum characters to return (default: 20000, max: 200000)' },
        offset: { type: 'number', description: 'Character offset to continue a long page from (the previous call says where it stopped)' },
        render: { type: 'boolean', description: 'Render the page in a real browser first (for JavaScript-only pages)' },
      },
      required: ['url'],
    },
    // ctx.allowPrivate is set by the caller (lib/sdk-chat buildAllTools) from the agent's role and settings.webFetch.
    handler: async ({ url, max_length, offset, render }, ctx) => {
      try {
        const wf = require('./web-fetch').getWebFetch();
        const result = await wf.toolText({ url, max_length, offset, render }, ctx || {});
        preserve(result, `WebFetch:${url}`);
        return result;
      } catch (e) {
        if (e && e.code === 'TT_PERSISTENCE_FAILED') throw e;
        return `Fetch error: ${e.message}`;
      }
    },
  },

  RestartHub: {
    description: 'Restart My Maestro AI. IMPORTANT: You MUST save all memory (write_memory, write_session_notes) BEFORE calling this tool. The server will restart after a short delay, so this should be the LAST tool call in your response. Provide a resume_message describing what you were doing so the user can choose to continue after restart. CRITICAL: If a message says "RESTART COMPLETED" or "server has already restarted", do NOT call this tool again — the restart already happened. Just continue with the work described in the resume message.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the restart is needed (logged to server.log)' },
        resume_message: { type: 'string', description: 'A message describing what you were doing and what should happen next after the restart. This will be shown to the user in a popup so they can choose to resume. Be specific about the NEXT ACTION to take (not "restart") — e.g. "Test the GitHub tools by listing recent issues in the project repo and then create the CoS agent"' },
      },
      required: ['reason'],
    },
    handler: async ({ reason, resume_message }) => {
      const projectDir = path.join(__dirname, '..');

      console.log(`[RestartHub] Restart requested: ${reason}`);

      // Save pending restart action to disk so it survives the restart
      if (resume_message) {
        const pendingFile = path.join(projectDir, 'data', 'pending-restart-action.json');
        const pendingData = {
          reason,
          resume_message,
          agent: 'unknown', // Will be overridden by server.js if available
          timestamp: new Date().toISOString(),
        };
        try {
          fs.mkdirSync(path.join(projectDir, 'data'), { recursive: true });
          fs.writeFileSync(pendingFile, JSON.stringify(pendingData, null, 2));
          console.log(`[RestartHub] Saved pending restart action: ${resume_message}`);
        } catch (e) {
          console.error(`[RestartHub] Failed to save pending action: ${e.message}`);
        }
      }

      // One restart path for every install (lib/restart): systemd exits 75 and is respawned; others run safe-restart.sh.
      const r = require('./restart').requestRestart({ projectDir, reason, by: 'agent (RestartHub)' });
      if (r.error) return `Error: ${r.error}`;
      return `✅ Server restart scheduled (reason: ${reason}): ${r.note}. The user will be prompted to resume after restart.`;
    },
  },

  // ── Free Data Source Tools ─────────────────────────────────────────────

  defi_llama_protocol: {
    description: 'Get DeFi protocol data from DeFi Llama — TVL, chains, audit info, token data. Use for researching protocols involved in exploits or hacks.',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Protocol slug (e.g. "aave", "uniswap", "curve-dex", "euler")' },
      },
      required: ['slug'],
    },
    handler: async ({ slug }) => {
      try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
          https.get(`https://api.llama.fi/protocol/${slug}`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
          }).on('error', reject);
        });
        // Extract key fields, skip huge historical arrays
        const summary = {
          name: data.name,
          symbol: data.symbol,
          category: data.category,
          chains: data.chains,
          tvl: typeof data.tvl === 'number' ? data.tvl : (Array.isArray(data.tvl) ? data.tvl[data.tvl.length - 1] : data.tvl),
          chainTvls: data.currentChainTvls,
          url: data.url,
          twitter: data.twitter,
          audit_links: data.audit_links,
          audits: data.audits,
          description: data.description,
          gecko_id: data.gecko_id,
          treasury: data.treasury,
          mcap: data.mcap,
          oracles: data.oracles,
          forkedFrom: data.forkedFrom,
          listedAt: data.listedAt,
          slug: data.slug,
        };
        return JSON.stringify(summary, null, 2);
      } catch (e) {
        return `Error fetching protocol: ${e.message}`;
      }
    },
  },

  defi_llama_tvl_history: {
    description: 'Get TVL history for a DeFi protocol to detect sudden drops (potential exploit indicators).',
    parameters: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Protocol slug (e.g. "euler")' },
        days: { type: 'number', description: 'Number of recent days to return (default: 30)' },
      },
      required: ['slug'],
    },
    handler: async ({ slug, days = 30 }) => {
      try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
          https.get(`https://api.llama.fi/protocol/${slug}`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
          }).on('error', reject);
        });
        const tvls = (data.tvl || []).slice(-days);
        return JSON.stringify({ protocol: data.name, tvl_history: tvls }, null, 2);
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  },

  defi_llama_hacks: {
    description: 'Get list of DeFi hacks/exploits from DeFi Llama. Returns hack details including amount, technique, chain, and target.',
    parameters: {
      type: 'object',
      properties: {
        min_amount: { type: 'number', description: 'Minimum hack amount in USD (default: 0)' },
      },
      required: [],
    },
    handler: async ({ min_amount = 0 }) => {
      try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
          https.get(`https://api.llama.fi/hacks`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
          }).on('error', reject);
        });
        const filtered = (Array.isArray(data) ? data : [])
          .filter(h => (h.amount || 0) >= min_amount)
          .slice(0, 100); // Cap at 100
        return JSON.stringify({ total: filtered.length, hacks: filtered }, null, 2);
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  },

  defi_llama_search: {
    description: 'Search DeFi Llama protocols by name. Returns matching protocols with basic data.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (e.g. "curve", "compound")' },
      },
      required: ['query'],
    },
    handler: async ({ query }) => {
      try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
          https.get(`https://api.llama.fi/protocols`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
          }).on('error', reject);
        });
        const q = query.toLowerCase();
        const matches = data.filter(p =>
          (p.name || '').toLowerCase().includes(q) ||
          (p.symbol || '').toLowerCase().includes(q)
        ).slice(0, 20).map(p => ({
          name: p.name, slug: p.slug, symbol: p.symbol,
          tvl: p.tvl, category: p.category, chains: p.chains,
          change_1d: p.change_1d, change_7d: p.change_7d,
        }));
        return JSON.stringify({ results: matches }, null, 2);
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  },

  lookup_function_selector: {
    description: 'Look up an EVM function selector (4-byte hex) to get the function signature. Essential for decoding transaction calldata in exploit analysis.',
    parameters: {
      type: 'object',
      properties: {
        hex_signature: { type: 'string', description: 'The 4-byte hex selector (e.g. "0xa9059cbb" for transfer)' },
      },
      required: ['hex_signature'],
    },
    handler: async ({ hex_signature }) => {
      try {
        const https = require('https');
        const hex = hex_signature.startsWith('0x') ? hex_signature : `0x${hex_signature}`;
        const data = await new Promise((resolve, reject) => {
          https.get(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${hex}`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
          }).on('error', reject);
        });
        return JSON.stringify({
          hex: hex,
          matches: (data.results || []).map(r => r.text_signature),
          count: data.count,
        }, null, 2);
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  },

  lookup_event_signature: {
    description: 'Look up an EVM event topic hash to get the event signature. Useful for decoding event logs from exploit transactions.',
    parameters: {
      type: 'object',
      properties: {
        hex_signature: { type: 'string', description: 'The event topic hash (e.g. "0xddf252ad...")' },
      },
      required: ['hex_signature'],
    },
    handler: async ({ hex_signature }) => {
      try {
        const https = require('https');
        const hex = hex_signature.startsWith('0x') ? hex_signature : `0x${hex_signature}`;
        const data = await new Promise((resolve, reject) => {
          https.get(`https://www.4byte.directory/api/v1/event-signatures/?hex_signature=${hex}`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
          }).on('error', reject);
        });
        return JSON.stringify({
          hex: hex,
          matches: (data.results || []).map(r => r.text_signature),
          count: data.count,
        }, null, 2);
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  },

  query_nvd_cves: {
    description: 'Search the NIST National Vulnerability Database (NVD) for CVEs. Use for vulnerability research, security assessments, and threat analysis.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword (e.g. "ethereum", "solidity", "openssl")' },
        cve_id: { type: 'string', description: 'Specific CVE ID to look up (e.g. "CVE-2024-1234")' },
        severity: { type: 'string', description: 'Filter by CVSS severity: LOW, MEDIUM, HIGH, CRITICAL' },
        results: { type: 'number', description: 'Max results to return (default: 10, max: 50)' },
      },
      required: [],
    },
    handler: async ({ keyword, cve_id, severity, results = 10 }) => {
      try {
        const https = require('https');
        let url = `https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=${Math.min(results, 50)}`;
        if (cve_id) url += `&cveId=${cve_id}`;
        if (keyword) url += `&keywordSearch=${encodeURIComponent(keyword)}`;
        if (severity) url += `&cvssV3Severity=${severity.toUpperCase()}`;

        const data = await new Promise((resolve, reject) => {
          https.get(url, { headers: { 'User-Agent': 'MyMaestroAI/1.0' } }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
          }).on('error', reject);
        });

        const vulns = (data.vulnerabilities || []).map(v => {
          const cve = v.cve || {};
          const metrics = cve.metrics || {};
          const cvss3 = metrics.cvssMetricV31?.[0]?.cvssData || metrics.cvssMetricV30?.[0]?.cvssData || {};
          return {
            id: cve.id,
            published: cve.published,
            lastModified: cve.lastModified,
            description: (cve.descriptions || []).find(d => d.lang === 'en')?.value,
            severity: cvss3.baseSeverity,
            score: cvss3.baseScore,
            vector: cvss3.vectorString,
            references: (cve.references || []).slice(0, 3).map(r => r.url),
          };
        });
        return JSON.stringify({ totalResults: data.totalResults, vulnerabilities: vulns }, null, 2);
      } catch (e) {
        return `Error querying NVD: ${e.message}`;
      }
    },
  },

  query_osv: {
    description: 'Query the Open Source Vulnerability database (OSV.dev) for package vulnerabilities. Covers npm, PyPI, Go, Rust, Maven, and more.',
    parameters: {
      type: 'object',
      properties: {
        package_name: { type: 'string', description: 'Package name (e.g. "lodash", "django", "go-ethereum")' },
        ecosystem: { type: 'string', description: 'Package ecosystem: npm, PyPI, Go, crates.io, Maven, NuGet, Packagist, RubyGems, etc.' },
        version: { type: 'string', description: 'Optional specific version to check' },
      },
      required: ['package_name', 'ecosystem'],
    },
    handler: async ({ package_name, ecosystem, version }) => {
      try {
        const https = require('https');
        const payload = JSON.stringify({
          package: { name: package_name, ecosystem },
          ...(version ? { version } : {}),
        });

        const data = await new Promise((resolve, reject) => {
          const req = https.request('https://api.osv.dev/v1/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.write(payload);
          req.end();
        });

        const vulns = (data.vulns || []).slice(0, 20).map(v => ({
          id: v.id,
          summary: v.summary,
          severity: v.database_specific?.severity || v.severity?.[0]?.score,
          published: v.published,
          modified: v.modified,
          aliases: (v.aliases || []).slice(0, 3),
          affected_versions: (v.affected || []).slice(0, 1).map(a =>
            (a.ranges || []).map(r => ({ type: r.type, events: r.events }))
          ),
          references: (v.references || []).slice(0, 3).map(r => r.url),
        }));
        return JSON.stringify({ package: package_name, ecosystem, total: data.vulns?.length || 0, vulnerabilities: vulns }, null, 2);
      } catch (e) {
        return `Error querying OSV: ${e.message}`;
      }
    },
  },

  nist_pqc_status: {
    description: 'Get the current NIST Post-Quantum Cryptography standardization status. Returns info about selected algorithms (ML-KEM, ML-DSA, SLH-DSA, FN-DSA) and timeline.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      // Hardcoded reference data — updated as of 2026. These are finalized NIST standards.
      const status = {
        finalized_standards: [
          { algorithm: 'ML-KEM (CRYSTALS-Kyber)', standard: 'FIPS 203', type: 'Key Encapsulation', status: 'Final Standard (Aug 2024)', security_levels: [1, 3, 5] },
          { algorithm: 'ML-DSA (CRYSTALS-Dilithium)', standard: 'FIPS 204', type: 'Digital Signature', status: 'Final Standard (Aug 2024)', security_levels: [2, 3, 5] },
          { algorithm: 'SLH-DSA (SPHINCS+)', standard: 'FIPS 205', type: 'Digital Signature (hash-based)', status: 'Final Standard (Aug 2024)', security_levels: [1, 3, 5] },
        ],
        round_4_candidates: [
          { algorithm: 'FN-DSA (FALCON)', standard: 'Draft FIPS 206', type: 'Digital Signature (lattice)', status: 'Expected 2025', note: 'Compact signatures, complex implementation' },
          { algorithm: 'HQC', type: 'Key Encapsulation (code-based)', status: 'Round 4 selection', note: 'Alternative to lattice-based ML-KEM' },
        ],
        additional_signatures: {
          status: 'On-ramp selections announced',
          note: 'NIST selected additional signature algorithms for diversity beyond lattice-based schemes',
        },
        reference_url: 'https://csrc.nist.gov/projects/post-quantum-cryptography',
        migration_guidance: 'https://csrc.nist.gov/pubs/ir/8547/final',
      };
      return JSON.stringify(status, null, 2);
    },
  },

  // ── Persistent Task Queue ─────────────────────────────────────────────
  create_task: {
    description: 'Create a persistent one-shot task that fires when a condition is met. Use for follow-ups, delayed actions, or waiting for another agent to finish. Tasks survive server restarts.',
    parameters: {
      type: 'object',
      properties: {
        target_agent: { type: 'string', description: 'Agent slug that should execute the task (e.g., "cos", "main", "unit0x")' },
        trigger_type: {
          type: 'string',
          enum: ['at_time', 'delay', 'when_agent_idle'],
          description: 'When to fire: "at_time" (specific ISO datetime), "delay" (after N minutes), "when_agent_idle" (when target agent finishes current work)',
        },
        trigger_value: {
          type: 'string',
          description: 'For at_time: ISO datetime string.  For delay: number of minutes (e.g., "30").  For when_agent_idle: the agent slug to watch (e.g., "unit0x").',
        },
        action_prompt: { type: 'string', description: 'The full prompt/instructions to send to the target agent when the task fires' },
      },
      required: ['target_agent', 'trigger_type', 'action_prompt'],
    },
    handler: async (args, context) => {
      const { createTask } = require('./task-queue');
      const creator = context?.agentName || 'unknown';
      const result = createTask({
        creator_agent: creator,
        target_agent: args.target_agent,
        trigger_type: args.trigger_type,
        trigger_value: args.trigger_value,
        action_prompt: args.action_prompt,
      });
      return JSON.stringify(result);
    },
  },

  list_tasks: {
    description: 'List persistent tasks in the queue. Shows pending, completed, failed, and cancelled tasks.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'], description: 'Filter by status (optional)' },
        agent: { type: 'string', description: 'Filter by agent slug - shows tasks created by or targeting this agent (optional)' },
      },
    },
    handler: async (args) => {
      const { listTasks } = require('./task-queue');
      const tasks = listTasks(args);
      if (tasks.length === 0) return 'No tasks found.';
      return JSON.stringify(tasks, null, 2);
    },
  },

  cancel_task: {
    description: 'Cancel a pending task by ID. Only pending tasks can be cancelled.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'The task ID to cancel' },
      },
      required: ['task_id'],
    },
    handler: async (args) => {
      const { cancelTask } = require('./task-queue');
      const ok = cancelTask(args.task_id);
      return ok ? `Task #${args.task_id} cancelled.` : `Task #${args.task_id} not found or not pending.`;
    },
  },

  request_additional_rounds: {
    description: 'Request additional rounds for a Tiger Team investigation when you (the coordinator) feel the objective has not been fully met. This will pause the investigation and ask the user for approval to continue. Only use this near the end of your current work when you have partial results but need more time. Provide a clear justification of what remains to be done.',
    parameters: {
      type: 'object',
      properties: {
        justification: { type: 'string', description: 'Why additional rounds are needed - what remains incomplete and what you plan to investigate next' },
        proposed_rounds: { type: 'number', description: 'How many additional rounds you think you need (1-5)' },
      },
      required: ['justification'],
    },
    handler: async () => 'Error: request_additional_rounds handler not injected. This is a bug.',
  },

  start_tiger_team: {
    description: 'Launch a Tiger Team investigation with a coordinator agent leading participant agents through rounds of work. The coordinator gets the objective, can dispatch tasks to participants, and synthesizes results. Returns the full investigation output. Use this when you need multiple specialist agents to collaborate on a complex problem.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'The goal/objective for the Tiger Team to work on' },
        coordinator: { type: 'string', description: 'Agent slug for the coordinator/leader (e.g., "unit0x", "ir", "hunter")' },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of agent slugs to participate (e.g., ["hunter", "ir", "aisec"])',
        },
        max_rounds: { type: 'number', description: 'Maximum rounds of coordination (default: 5, max: 15)' },
        context: { type: 'string', description: 'Optional additional context to provide to the coordinator' },
      },
      required: ['objective', 'coordinator', 'participants'],
    },
    // Handler is injected in sdk-chat.js because it needs access to SSE context and consultViaHub
    handler: async () => 'Error: start_tiger_team handler not injected. This is a bug.',
  },

  request_tools: {
    description: `Load additional tool categories on-demand. Call this FIRST when you need specialized tools not in your current set.

Available categories:
- slack: Slack messaging, search, channels, DMs
- google_calendar: Calendar events, scheduling, freebusy
- google_drive: Drive files, folders, sharing
- google_docs: Google Docs read/create/edit
- google_sheets: Spreadsheet read/write/format
- google_slides: Presentations
- google_forms: Forms
- google_tasks: Task lists and tasks
- gmail: Email search
- github: Repos, PRs, issues, code search
- jira: Tickets, issues, sprints, boards
- playwright: Browser automation, web UI interaction
- auth_http: Direct authenticated HTTP/GraphQL security tests with local named identities and reviewed scope
- sequential_thinking: Structured step-by-step reasoning

You can request multiple categories at once. Tools persist for the rest of this conversation turn.`,
    parameters: {
      type: 'object',
      properties: {
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of category names to load (e.g., ["slack", "github", "jira"])',
        },
      },
      required: ['categories'],
    },
    // Handler is injected in sdk-chat.js because it needs access to the tool state
    handler: async () => 'Error: request_tools handler not injected. This is a bug.',
  },

  ...require('./tools/auth-http').tools,
};

// ── Schema Conversion ───────────────────────────────────────────────────

/**
 * Convert a built-in tool definition to OpenAI function-calling format.
 */
function builtinToolToOpenAI(name, def) {
  return {
    type: 'function',
    function: {
      name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}

// ── Tool Call Execution ─────────────────────────────────────────────────

/**
 * Execute a single tool call and return the result string.
 */
async function executeToolCall(toolCall, handlers) {
  const funcName = toolCall.function?.name;
  const handler = handlers.get(funcName);

  if (!handler) {
    return `Error: Unknown tool "${funcName}"`;
  }

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch (e) {
    return `Error parsing arguments for ${funcName}: ${e.message}`;
  }

  try {
    const result = await handler(args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (e) {
    if (e && e.code === 'TT_PERSISTENCE_FAILED') throw e;
    return `Error executing ${funcName}: ${e.message}`;
  }
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  BUILTIN_TOOLS,
  executeToolCall,
  builtinToolToOpenAI,
};
