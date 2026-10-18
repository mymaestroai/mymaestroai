# TOOLS.md — Capabilities & Environment

## Available Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **Bash** | Execute shell commands | Full system access — git, npm, curl, etc. |
| **Read** | Read file contents | Returns content with line numbers. Supports offset/limit for large files. |
| **Write** | Create or overwrite files | Creates parent directories automatically. |
| **Edit** | Find and replace text | Exact string match — use for surgical edits. |
| **Glob** | Find files by pattern | Returns paths sorted by modification time. |
| **Grep** | Search file contents | Regex-powered. Use `include_content: true` to see matching lines. |
| **WebSearch** | Search the web | DuckDuckGo-powered. No API key needed. |
| **WebFetch** | Fetch & extract web content | Strips HTML, returns readable text. |
| **read_memory** | Read long-term memory | Your persistent knowledge base. |
| **write_memory** | Update long-term memory | Replaces entire memory section. |
| **read_session_notes** | Read daily session notes | Today's or a specific date's notes. |
| **write_session_notes** | Append to today's notes | Quick session persistence. |
| **read_shared_memory** | Read shared knowledge pool | Cross-agent knowledge base. |
| **write_shared_memory** | Write to shared pool | Other agents can read what you write. |
| **search_shared_memory** | Search shared pool | Keyword search across all topics. |
| **consult_agent** | Ask another agent | Routes to the agent's model with full context. |
| **list_agents** | List all agents | Shows names and models. |

## Environment

- **OS:** macOS
- **Shell:** zsh
- **Node.js:** Available (server runtime)
- **Package manager:** npm

## Tool Usage Guidelines

- **Read before you write.** Always check the current state of a file before editing it.
- **Use Edit for surgical changes.** Don't rewrite entire files when a find-and-replace will do.
- **Bash is your Swiss Army knife.** When in doubt, a shell command can do it.
- **WebSearch + WebFetch combo** — search to find URLs, then fetch to read the content.
- **Memory is your superpower.** Write learnings to memory. Read memory at the start of complex tasks.
- **Always save memory before restarting the server.**

## MCP Skills

MCP skills (Slack, GitHub, Google Workspace, Glean, etc.) are configured in `lib/skills/skill-manager.js`. When skills are active, their tools appear automatically. Key skill tool patterns:

| Skill | Tool Prefix | Example |
|-------|-------------|---------|
| Slack | `slack__` | `slack__slack_send_message` |
| Google Workspace | `google-workspace__` | `google-workspace__list_calendar_events` |
| GitHub | `github__` | `github__get_file_contents` |
| Glean | `glean__` | `glean__search` |

**IMPORTANT:** When sending messages to anyone other than the user, ALWAYS identify yourself as an AI agent operating on their behalf.
