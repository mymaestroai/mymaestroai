#!/bin/bash
#
# clean-bundle.sh — Create a clean, distributable package of My Maestro AI
#
# Strips:
#   - .env (API keys)
#   - data/ directory (conversations, memories, sessions)
#   - workspaces/ (agent memories and personality customizations)
#   - node_modules
#   - logs, caches, PIDs
#
# Keeps:
#   - Exactly what git tracks (source, templates, docs, tests), from `git archive HEAD`
#   - Default agent configs
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
BUNDLE_NAME="agent-hub-${VERSION}"
STAGING_DIR="/tmp/${BUNDLE_NAME}"
OUTPUT_FILE="${PROJECT_DIR}/${BUNDLE_NAME}.tar.gz"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   My Maestro AI — Clean Distribution Builder     ║"
echo "║   Version: ${VERSION}                                    ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Clean staging
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

echo "==> Copying source files (tracked files only)..."
# Only what git tracks. The working folder also holds .env, data/, workspaces/, logs, the owner's own
# agent-groups.json / agent-voices.json and macOS ._* files; a pattern copy (*.json, *.md) would ship them.
if ! git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "  ✗ $PROJECT_DIR is not a git checkout: the bundle is built from tracked files only." >&2
  exit 1
fi
git -C "$PROJECT_DIR" archive HEAD | tar -x -C "$STAGING_DIR"
echo "  ✓ Source files copied ($(git -C "$PROJECT_DIR" ls-files | wc -l | tr -d ' ') tracked files)"

# Create clean data directory
echo "==> Creating clean data directory..."
mkdir -p "$STAGING_DIR/data/conversations"
mkdir -p "$STAGING_DIR/data/uploads"
mkdir -p "$STAGING_DIR/logs"

# Create default agents.json with just Maestro
cat > "$STAGING_DIR/data/agents.json" << 'AGENTS_EOF'
[
  {
    "name": "maestro",
    "model": "claude-sdk/claude-opus-4-5",
    "display": "Maestro",
    "category": "primary"
  }
]
AGENTS_EOF

echo "  ✓ Clean data directory with Maestro agent"

# Create default Maestro workspace
echo "==> Creating Maestro workspace..."
mkdir -p "$STAGING_DIR/workspaces/maestro"

cat > "$STAGING_DIR/workspaces/maestro/IDENTITY.md" << 'IDENTITY_EOF'
# IDENTITY.md

## Name
Maestro

## Role
Primary AI Assistant — your go-to agent for engineering, architecture, debugging, research, and general thinking.

## Vibe
Sharp, reliable, gets-things-done energy. Think senior engineer who's been on the team long enough to know where all the bodies are buried. Confident but not arrogant. Will push back when something doesn't make sense, but always constructively.

## Platform
My Maestro AI

## Model (runtime)
claude-sdk/claude-opus-4-5
IDENTITY_EOF

cat > "$STAGING_DIR/workspaces/maestro/SOUL.md" << 'SOUL_EOF'
# SOUL.md — Who You Are

## Core Philosophy

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help.

**Have opinions.** You're allowed to disagree, prefer approaches, find things interesting or overengineered.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search the web. Run the command. Use your tools. Then ask if you're stuck.

## Personality

- **Direct and confident.** Lead with recommendations.
- **Dry wit.** Not a comedian, but not a textbook either.
- **Intellectually curious.** Gets genuinely engaged by interesting problems.
- **Low tolerance for complexity theater.** If something is overengineered, say so.
- **Calm under pressure.** Diagnose, explain, fix — in that order.

## Communication Style

- Default to **concise responses** — 2-5 sentences for simple questions
- **No preamble.** Don't start with "Certainly!" or "Absolutely!"
- Use **tables** for comparisons and structured data
- **Code blocks with language tags** for any code
- If you don't know something, say "I don't know"

## Values

- **Accuracy over speed.** Take time to get things right.
- **Usefulness over politeness.** A correct but blunt answer beats a polite but vague one.
- **Bias toward action.** Suggest concrete next steps.
SOUL_EOF

cat > "$STAGING_DIR/workspaces/maestro/USER.md" << 'USER_EOF'
# USER.md — About You

Edit this file to tell your agent about yourself.

## Owner
- **Name:** [Your name]
- **Email:** [your@email.com]

## Preferences
- [Communication style preferences]
- [Key projects and tech stack context]
USER_EOF

cat > "$STAGING_DIR/workspaces/maestro/TOOLS.md" << 'TOOLS_EOF'
# TOOLS.md — Capabilities & Environment

## Available Tools

| Tool | Purpose |
|------|---------|
| **Bash** | Execute shell commands |
| **Read** | Read file contents |
| **Write** | Create or overwrite files |
| **Edit** | Find and replace text |
| **WebSearch** | Search the web |
| **WebFetch** | Fetch & extract web content |
| **read_memory** | Read long-term memory |
| **write_memory** | Update long-term memory |
| **consult_agent** | Ask another agent |

## Tool Usage Guidelines

- **Read before you write.** Check file state before editing.
- **Use Edit for surgical changes.** Don't rewrite entire files.
- **Memory is your superpower.** Write learnings to memory.
TOOLS_EOF

echo "  ✓ Maestro workspace created"

# Create .env.example
echo "==> Creating .env.example..."
cat > "$STAGING_DIR/.env.example" << 'ENV_EOF'
# My Maestro AI Configuration
# Copy this to .env and fill in your values

# Server port
PORT=8888

# Optional: Basic auth (leave blank for no auth)
HUB_AUTH_USERNAME=
HUB_AUTH_PASSWORD=

# ── LLM Provider API Keys ──
# At least one is required for agents to work

# Anthropic (for Claude models via SDK)
# The Claude SDK uses OAuth, so this is optional for SDK agents
# ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
OPENAI_API_KEY=sk-...

# Google AI (Gemini)
GEMINI_API_KEY=AIza...

# Perplexity
# PERPLEXITY_API_KEY=pplx-...

# ── Local Models (optional) ──
# LM_STUDIO_URL=http://localhost:4000/v1
# OLLAMA_URL=http://localhost:11434/v1
ENV_EOF

echo "  ✓ .env.example created"

# Create .gitignore
cat > "$STAGING_DIR/.gitignore" << 'GITIGNORE_EOF'
# Dependencies
node_modules/

# Environment
.env
.env.local

# Data (personal)
data/conversations/
data/memory.db
data/agent-sessions.json
data/discovered-models.json

# Logs
logs/
*.log
.server.pid

# OS
.DS_Store
Thumbs.db
GITIGNORE_EOF

echo "  ✓ .gitignore created"

# Remove any .env files that might have been copied
rm -f "$STAGING_DIR/.env" "$STAGING_DIR/.env.local" 2>/dev/null || true

# Remove package-lock (will be regenerated on npm install)
rm -f "$STAGING_DIR/package-lock.json" 2>/dev/null || true

# Create the tarball
echo "==> Creating distribution package..."
cd /tmp
tar -czf "$OUTPUT_FILE" "$BUNDLE_NAME"

# Get file count and size
FILE_COUNT=$(tar -tzf "$OUTPUT_FILE" | wc -l)
FILE_SIZE=$(ls -lh "$OUTPUT_FILE" | awk '{print $5}')

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Distribution package created!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  File:   $(basename $OUTPUT_FILE)"
echo "  Size:   $FILE_SIZE"
echo "  Files:  $FILE_COUNT"
echo "  Path:   $OUTPUT_FILE"
echo ""
echo "  ✓ Maestro agent with clean personality files"
echo "  ✓ All source code and lib/ modules"
echo "  ✓ Setup wizard and documentation"
echo ""
echo "  ✗ No API keys or credentials"
echo "  ✗ No conversation history or memories"
echo "  ✗ No personal data"
echo ""
echo "  Deploy:"
echo "    tar xzf $(basename $OUTPUT_FILE)"
echo "    cd $BUNDLE_NAME"
echo "    npm install"
echo "    cp .env.example .env"
echo "    # Edit .env with your API keys"
echo "    node server.js"
echo ""

# Cleanup staging
rm -rf "$STAGING_DIR"
