# My Maestro AI

Multi-agent AI chat platform with multi-provider LLM routing. Run AI agents with persistent memory, MCP skill integrations, scheduled tasks, and rich personality systems.

## Quick Start

One command, on a Mac or a Linux machine (Ubuntu, Debian; on Windows, inside WSL):

```bash
curl -fsSL https://raw.githubusercontent.com/mymaestroai/mymaestroai/main/install/install.sh | bash
```

Or download it, read it, then run it: `curl -fsSLO https://raw.githubusercontent.com/mymaestroai/mymaestroai/main/install/install.sh && less install.sh && bash install.sh`.
The same script is `install/install.sh` in this repository. Inside your home folder and without sudo, it:

1. downloads Node.js 22 from nodejs.org (checksum verified) into `~/.mymaestroai/node`, used only by My Maestro AI;
2. downloads the code into `~/mymaestroai` with git (which is what lets the Update button work) and installs its packages;
3. makes it start by itself (a systemd user service on Linux, a launchd agent on macOS) and adds the `mymaestro` command;
4. opens the **Welcome page**: create your account (with two-factor and recovery codes), connect one AI (a Claude
   subscription, an API key, or a local model, each proven with a real request), and meet **Maestro**, your lead
   agent, which interviews you, builds your first agents with the right models and personalities, shows what each
   can do, and helps you set up the phone app.

If the repository you install from is private, the installer needs access: it uses your GitHub SSH key if you have
one, or asks for a read-only token (it explains how to make one) and keeps it in `~/.mymaestroai/git-credentials`,
readable only by you, so updates keep working. A public repository needs nothing. Options: `--dir`, `--port`, `--channel stable|experimental`, `--no-service`,
`--no-open`, `--dry-run` (shows every step, changes nothing), `--uninstall` (keeps your data).

The first account needs the one-time setup code the installer prints. Lost it? `mymaestro setup-link` shows the link
again (until the first account exists).

### The mymaestro command

Works even when the hub is stopped:

```
mymaestro status | start | stop | restart | logs [-f] [-n N] | open | setup-link
mymaestro update [--channel stable|experimental]   same as the Update button
mymaestro doctor                                   security check plus a real Claude sign-in test
mymaestro backup [--to DIR]                        data, settings and agents in one archive
mymaestro reset-2fa <email>                        lost phone: turn two-factor off for an account
mymaestro service install | remove                 start by itself at boot (Linux) or login (Mac)
mymaestro uninstall                                removes the service, the command and the private Node; keeps your data
```

Help is also in the app: the **?** button at the top right (and Help in the phone menu) covers creating and changing
agents, models, reminders, the phone app, and what to do when something is wrong.

## Features

| Feature | Description |
|---------|-------------|
| **Multi-agent chat** | Create and manage multiple AI agents with distinct personalities |
| **Persistent memory** | SQLite-backed memory survives restarts; agents get smarter over time |
| **MCP Skills** | Plug in tools: Google Workspace, Slack, GitHub, PagerDuty, etc. |
| **Scheduled tasks** | Cron and calendar-relative task scheduling per agent |
| **Agent delegation** | Agents delegate to named worker agents inside the platform, with a live roster of who is free |
| **Temporal workers** | Agents spawn parallel, ephemeral workers and **choose the model for each** — Claude, OpenAI, Gemini, local — so delegation is not tied to one vendor |
| **Interjection** | Type while an agent is working; it takes your message into account mid-turn (Claude SDK and gateway agents) |
| **Tiger Team recovery** | Durable checkpoints: multi-agent runs resume after a crash, disconnect or restart without redoing finished work |
| **Tool confirmation** | Toggle auto-approve vs manual confirmation for mutating operations |
| **Multi-provider LLM** | Route to Anthropic, OpenAI, Google, Perplexity, LM Studio, Ollama |
| **Claude SDK** | Direct Claude SDK integration via OAuth for Claude Pro/Max subscribers; always loads the newest SDK installed |
| **On-chain wallets** | A dedicated agent can trade on Base through DEXs and call any contract, with simulate-first, dry-run paper trading, an encrypted keystore, a pause switch and a full audit log. Losses are capped by what you put in the wallet |
| **Localhost by default** | Listens on `127.0.0.1` only; network access is an explicit opt-in that requires Basic auth |

## Architecture

```
server.js            — HTTP server, API routes, SSE streaming
app.js               — Frontend application logic
index.html           — Main UI
lib/
  sdk-chat.js        — Chat engine, conversation management
  gateway-client.js  — Multi-provider LLM client (streaming, retries)
  agents.js          — Agent config and personality loading
  memory-db.js       — SQLite memory system
  provider-tools.js  — Built-in tool definitions
  scheduler.js       — Task scheduler (cron + calendar)
  skills/
    skill-manager.js — MCP skill registry and lifecycle
    mcp-stdio.js     — MCP stdio transport
    mcp-streamable-http.js — MCP HTTP transport
workspaces/
  <agent>/           — Per-agent personality files
    IDENTITY.md      — Name, role, vibe
    SOUL.md          — Personality, values, communication style
    TOOLS.md         — Available tools and guidelines
    USER.md          — User context and preferences
    TASKS.md         — Scheduled tasks (optional)
data/
  agents.json        — Agent registry
  conversations/     — Chat history (JSONL)
  memory.db          — Long-term memory (SQLite)
```

## Creating Agents

Click **+ New** in the sidebar. The wizard generates personality files (IDENTITY.md, SOUL.md, TOOLS.md, USER.md) automatically. Customize them via the settings gear icon.

## Adding MCP Skills

Skills are configured in `lib/skills/skill-manager.js`. Each needs:
- Transport type (`stdio` or `http`)
- MCP command or URL
- Authentication tokens (via environment variables)

## Subscription or API Credits

The model id says who pays. `claude-sdk/…` runs through the Claude Code client on this machine's Claude sign-in
(Max or Pro) and `codex-cli/…` on the ChatGPT subscription: no per-token bill. `anthropic/…`, `openai/…`,
`google/…` and `perplexity/…` run through the hub on that provider's API key and are billed per token to your
credits. Local providers are free. Pickers label every group, the agent list badges API-key agents with "API $",
and the Claude client never sees the Anthropic API key, so adding one (to use `anthropic/` models) cannot move
subscription agents onto the API bill.

## Modules (optional capabilities with a guided setup)

The **Modules** page (account menu → Modules, or Settings → Modules) lists optional capabilities. Each walks you
through its setup step by step: what it does and risks, what to do on the provider's site, installing its tool
server, entering the key (encrypted in the hub), checking it works, setting limits, and choosing the agents.
Modules that move money can only go to wallet agents (`walletAgents` in `data/settings.json`, never member
agents), and the hub enforces their limits on every call, before the provider sees it; every order attempt is
logged on the module's Activity log.

Adding a module is one folder; see `modules/README.md` for the format.

## Prompt Caching (API-key models)

Every model call resends the agent's instructions, its tool definitions and the conversation, about 20,000
tokens or more per call. On API keys the hub keeps that opening identical from call to call so providers can
bill it at their cache rate:

- **Anthropic API (`anthropic/`)**: the hub marks the tools, system prompt and latest message for caching.
  After the first turn about 98% of the input is read from cache, at 5-10% of the normal price (writing it the
  first time costs 25% extra). Measured: a tool-using turn on Sonnet 5.5 went from about $0.097 to $0.007.
- **OpenAI**: cached automatically; the hub adds a per-agent cache key (a hash, not the agent's name).
  About 95% of the input is read from cache after the first turn, at OpenAI's cache rate.
- **Google Gemini**: Google caches repeated openings on its own when it chooses; the hub keeps the opening stable.
- **Local servers (NInfer, LM Studio, Ollama)**: their prefix cache gets the same stable opening (faster replies).
- **Subscription agents (`claude-sdk/`, `codex-cli/`)**: the Claude and Codex clients cache on their own.

What keeps the opening stable: past messages carry their date and time, not "5m ago"; old messages are dropped
in blocks, not one per turn; per-message search hits travel with the new message instead of the system prompt.
The ledger prices cached tokens at the cache rate, and the server log prints a `[cache]` line per turn.
Setting (`data/settings.json`): `"promptCache": { "enabled": true, "ttl": "5m" }`; `"ttl": "1h"` keeps
Anthropic's cache for an hour (writes cost 2x instead of 1.25x; worth it for agents used less than every 5 minutes).

## Your Agents Stay Yours

The code names no agent and no person. Everything specific to your install lives in `data/` and `workspaces/`,
which git never tracks (`.gitignore` ignores all of `data/` except the example):

- **Team folders**: an agent is on the medical or legal team when its own folder grants include `medical/` or
  `legal/` (agent settings page, Tool policy, extra folders). Such agents are also never sent to a hosted classifier.
- **Wallet agent**: `walletAgents` in `data/settings.json` (none by default); the owner's receiving address is
  `walletOwner` `{ "address": "0x…", "label": "you.eth" }` (none by default: then nothing can leave the wallet).
- **Team templates** for "Create team" on the Users page: `teamTemplates` in `data/settings.json`,
  `{ "medical": { "folder": "medical", "members": ["<agent>", …], "head": "<agent>" } }`.

## Admins and Member Permissions

Any number of accounts can hold the **admin** role and manage the hub together: settings, users, every agent,
approvals. Invite or promote them on the Users page; the hub never lets the last admin be demoted, disabled or
deleted, and every change is in the audit log. Members' agents are fenced in by default: their own folders only,
no web, nothing sent off the machine. Admins open that up in three layers: **Settings → Member agents:
permissions** for every member agent, **Users → Agent permissions** for one member's agents (including outside
agents they may consult), and the **Tool policy** table on an agent's settings page for one agent. Changing the
hub, destructive actions and money are never available to member agents.

## Setup Checklist

**Settings → Setup checklist** is the hub checking its own machine: accounts and two-factor, a way to run models,
Docker and the sandbox image for member agents, PDF and web reading, and how the hub is restarted. Each line says
what is missing and the exact command or click to fix it on that computer (Homebrew on a Mac, apt on Debian). A
banner appears while anything critical is missing, the Users page repeats the sandbox prerequisites before you
invite a member, and a sandboxed agent whose shell is withheld says why in its reply.

## Security Check

**Settings → Security check** reviews how the installation is set up and says what is risky and how to fix it: accounts and two-factor; how the hub can be reached (bind address, Tailscale Serve or Funnel, tunnels, notification endpoints); secrets and file permissions (with a one-click tighten); agent policies, sandboxes and the agents that run on the host; API tokens and root (sudo without a password, the docker group, root grants, the root audit); this machine's open doors (services on every interface, SSH passwords, other accounts, backups); and the code (Node.js line, a restart that is pending, local edits, the lock file). It runs every night (`HUB_SECURITY_CHECK_HOURS`, default 24; 0 turns the schedule off) and a banner names anything critical. The same check runs from a terminal with no hub process and no agent:

```bash
node scripts/security-check.js            # plain-text report
node scripts/security-check.js --json     # for scripts; exit code 2 critical, 1 warnings, 0 clean
node scripts/security-check.js --fix-modes   # tighten the file permissions it flags, then report
```

Nothing it prints is a secret: names, modes and counts only. Root-only facts (an unreadable tunnel config, a firewall) are listed as "not checked here" rather than guessed.

## The Hub Map

`docs/HUB-MAP.md` is the complete operational map of the software, written for the lead agent (Maestro) so it can help with installation, configuration and repair: layout, every module, every setting and environment variable, accounts and access, agents, memory and context, tools and policy, extensions, the API, troubleshooting and step-by-step setup recipes. The lead agent gets a short "this hub" brief with live facts (version, commit, restart pending, port, accounts, providers, checklist) on every turn and reads the map on demand; `hubBrief: false` in settings turns the brief off.

## Local Models

Local models run through one proxy, llama-swap, that the hub installs and configures from the **Local models** page: it starts the right engine for the model a request names (llama.cpp's `llama-server` for GGUF files, NInfer for `.ninfer` files, or any command that serves an OpenAI-compatible API), keeps the model loaded while it is in use, swaps when a different model is asked for, and unloads idle ones. Models appear as `local/<id>` in every picker, are free in the ledger, and get their context window from the registry. The page scans your model folders, builds llama.cpp for your machine in the background (CUDA when present, Homebrew on a Mac), shows what is loaded, and tests a model with one click. Keep LM Studio's and Ollama's own servers off while this is on: one scheduler per GPU.

## Agent Sandboxes

With Docker present, an agent can run its shell and file tools inside a container of its own: build the image
once (`docker build -t agent-hub-sandbox sandbox/`, or the button under **Settings → Agent sandboxes**), then set
an agent's **Sandbox** to *container* on its settings page. Member-owned agents default to a container; admin-side
agents default to off. The box holds only that agent's folders, mounted at the same paths as on the host; hub
tools (memory, Records, consultations, policy) stay outside. If no sandbox can be used, a sandboxed agent gets no
shell instead of running on the host.

## One Set of Hands

Bash, Read, Write, Edit, Glob, Grep, WebSearch and WebFetch are one implementation (`lib/hub-tools.js`) used by
every model path: gateway and local models always, and Claude Code or Codex client agents when their **Tools**
setting (agent settings page) or the hub default (**Settings → Agent sandboxes → Tools**) says *hub*. The names and
parameters are Claude Code's, so models use them fluently; Read shows images and PDF pages (needs poppler-utils);
Edit needs a Read first and an exact, unique match. With hub tools the client's own built-ins are switched off and
the hub's versions take their place, every call passes the policy gate, and a sandboxed agent's hands act inside its
container while the client stays on the host, so no sign-in ever enters the box. The default stays *client* until
you switch an agent.

## Web Search and Fetch

Every agent, on every model, gets the same `WebSearch` and `WebFetch` tools; the hub does the work. Search walks the
backends you configure under **Settings → Web search and fetch** (Brave, Perplexity, Serper, Tavily, a self-hosted
SearXNG, then DuckDuckGo with no key at all) and returns the first that answers; an agent may name a backend when it
wants that one. An install with only local models needs no key: the hub can run SearXNG for it as a Docker container
(**Run SearXNG here**), with DuckDuckGo as the fallback. Fetch returns pages as markdown with links kept, reads PDFs
(needs `pdftotext` from poppler-utils), renders JavaScript-only pages in a browser when Playwright Firefox is
installed for a Python on the machine (`pip install playwright && playwright install firefox`), and refuses private
and local addresses unless you allow them for admin-side agents (the default) or everyone.

## Data Connectors

Outside services plug in as data from **Settings → Data connectors**: any stdio MCP server (the hub
starts it with only its own secrets in the environment), or one of the built-in skills wrapped so it
gets the same controls. Per connector you choose which agents may use it (all, or a list; never through a
consultation), how it is protected (always on, its own passphrase, or a group passphrase such as
"medical" that unlocks every connector in the group), a data home folder, and a policy class per tool.
Unlocks expire after `connectorsUnlockMinutes` (default 240) and on restart. Tools appear to agents as
`<connector>__<tool>`. Nothing is on by default; other installs are unaffected until a connector is added.

## Claude SDK Setup

My Maestro AI supports the Claude Agent SDK, which provides direct Claude access via OAuth for Claude Pro/Max subscribers. This is the recommended way to run Claude-based agents — no API key required.

### Prerequisites

1. **Claude Pro or Max subscription** — SDK access requires an active subscription
2. **Claude Code CLI** — Install from [claude.ai/code](https://claude.ai/code)

### Setup

```bash
# Install the Claude Agent SDK globally
npm install -g @anthropic-ai/claude-agent-sdk

# Authenticate with Claude (opens browser for OAuth)
claude auth login
```

Once authenticated, credentials are stored in `~/.claude/.credentials.json`. My Maestro AI will automatically detect these and route `claude-sdk/*` models through the SDK.

### Using SDK Agents

When creating an agent, select any model prefixed with `claude-sdk/`:
- `claude-sdk/claude-opus-4-8` — Most capable (or newer if available)
- `claude-sdk/claude-sonnet-4-6` — Balanced
- `claude-sdk/claude-haiku-4-5` — Fast and lightweight

Model discovery runs on startup and probes for the latest available versions.

SDK agents have full tool access (bash, file operations, web search) and persistent sessions.

## Environment Variables

See `.env.example` for the full list. Key ones:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | No* | Anthropic API key (not needed if using SDK) |
| `OPENAI_API_KEY` | No* | OpenAI API key |
| `GEMINI_API_KEY` | No | Google Gemini API key |
| `USER_EMAIL` | No | Your email for personalization |
| `HUB_AUTH_USERNAME` / `HUB_AUTH_PASSWORD` | No | Legacy single-password login, honoured only while the hub has no accounts. Once an admin account exists it is ignored (remove the two lines); network exposure then requires an admin with two-factor, and programs sign in with API tokens (Users page → API tokens, or `node scripts/hub-token.js`) |
| `HUB_BIND_HOST` | No | Address to listen on. Default `127.0.0.1`. e.g. `0.0.0.0` for LAN access — honoured only when both auth values are set |
| `CLAUDE_SDK_PATH` | No | Pin a specific Claude Agent SDK copy instead of auto-selecting the newest installed |
| `CLAUDE_CLI_PATH` | No | Pin the Claude Code client binary the SDK spawns. Default: the globally installed `@anthropic-ai/claude-code`, falling back to the SDK's embedded copy |
| `SLACK_USER_ID` | No | Your Slack member ID |

*At least one LLM provider (SDK auth or API key) is required for agents to work.

## What's New

See [CHANGELOG.md](CHANGELOG.md) for release notes, including upgrade notes for each version.

## Updating

Click **Update** in the toolbar (on the phone: menu → **Update hub**). The dialog asks which channel to follow: **stable** (promoted code, the default) or **experimental** (the latest work, ahead of stable), with your current choice preselected; you can switch back and forth at any time. The hub then fetches from GitHub, shows the incoming changes, fast-forwards, installs dependencies if they changed, and restarts. Your `.env`, `data/` and `workspaces/` are not tracked by git, so an update never touches them.

This works on installs made with `git clone`. If the repository is private, the hub (which runs in the background) uses the credentials git saved when you cloned: enable a credential helper once (`git config --global credential.helper store`, or `osxkeychain` on macOS) and sign in with a GitHub personal access token as the password.

**Updated from before multi-user?** An install with no account yet opens the Welcome page (`/welcome`). Creating the
first account needs the setup code: `mymaestro setup-link` (or `node scripts/hub-cli.js setup-link` in the hub
folder) prints the link, and the server log shows it at every start until the account exists.

**Installed from a tarball?** Those installs have no git history and cannot update themselves. Move to a clone once: stop the hub, rename the old folder, `git clone https://github.com/mymaestroai/mymaestroai.git`, copy `.env`, `data/` and `workspaces/` from the old folder into the new one, run `npm install --omit=dev`, and start it.

## Running as a systemd service (Linux)

The Restart button, the agents' RestartHub tool and `scripts/restart.sh` all work under systemd: the server
exits with code 75 and systemd starts it again on the new code. Use `Restart=always` or `Restart=on-failure`
in the unit (both restart on 75). A clean stop (`systemctl stop`) still exits 0. If the unit logs with
`StandardOutput=append:…/server.log`, systemd creates that file as root; the hub never needs to write it
itself (restart output goes to `data/restart.log`), but a user service (`systemctl --user`) avoids the
question entirely.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| The page won't load | `mymaestro status`, then `mymaestro restart`; `mymaestro logs` shows why it stopped |
| A Claude agent says "not signed in", "authentication" or "expired" | In a terminal: `claude`, sign in, `/exit`. Send the message again; no restart. `mymaestro doctor` tests the sign-in |
| "Usage limit reached" | Wait for the plan to reset, or switch the agent's model from the chat header |
| An API key is refused | Settings → LLM Providers: paste a fresh key |
| Lost the phone with the two-factor app | Sign in with a recovery code, or `mymaestro reset-2fa you@example.com` on the hub's computer |
| Lost the first-time setup link | `mymaestro setup-link` |
| Port already in use | Install with `--port N`, or change `PORT=` in `.env` and `mymaestro restart` |
| MCP skill not loading | Check its token in Settings, then `mymaestro restart` |

## License

PolyForm Noncommercial License 1.0.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 Jeff Lunglhofer.

Free for noncommercial use: personal, hobby, research, education, and running it for yourself. Any
commercial use, including running it for clients or inside a business, needs a commercial license from
the copyright holder: owner@example.com. Bundled third-party libraries under `vendor/` keep their own
licenses, listed in NOTICE. No warranty.
