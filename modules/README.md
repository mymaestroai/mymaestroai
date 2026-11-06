# Modules: how to add one

A module is an optional capability (an exchange, a mail account, a search service...) that an admin adds from the
**Modules** page with a guided setup. One folder per module; the hub core never names a module.

```
modules/<id>/
  module.json   what it is, its risk, what it needs, secrets, settings, tool server, tool classes
  setup.json    the guided setup, step by step
  index.js      optional: checks for "check" steps, guard() for per-call limits
  guide.md      optional: a longer setup guide (detected from the file; nothing to declare)
```

The core (`lib/modules/`) runs the setup, stores state in `data/modules.json`, installs the tool server into
`data/modules/<id>/pkg`, and registers the module as a data connector whose command is the guard
(`lib/modules/mcp-guard.js`). Secrets live in the connector vault (encrypted). Agent access and the tool policy work
as for any connector. A module's connector can only be changed by the module (the Connectors page refuses).

## module.json

| Field | Meaning |
|---|---|
| `id` | Folder name; lowercase letters, digits, dashes. Also the connector id; tools reach agents as `<id>__<tool>`. |
| `name`, `icon`, `category`, `summary` | Shown on the Modules page (cards are grouped by category). |
| `risk` | `read`, `write`, `send` or `money`. Any `money` tool requires `risk: "money"`. |
| `requires` | e.g. `{ "node": ">=22" }`; checked before installing. |
| `server` | `{ "type": "mcp-stdio", "npm": { "package", "version", "bin" }, "args", "env", "dataEnv" }` or `{ "type": "mcp-stdio", "script": "server.js" }` (a file inside the folder). `version` must be exact: updates are deliberate. `dataEnv` names an environment variable that receives the module's private data folder (also its `HOME`). |
| `secrets` | `[{ "name": "UPPER_CASE", "label", "help", "multiline", "optional" }]`; passed to the server as environment variables. |
| `settings` | `[{ "key", "type": "boolean" \| "number" \| "string" \| "list" \| "choice", "label", "help", "default", "min", "max", "pattern", "options", "multiple" }]`. Every setting needs a default, and the default must be the safe choice: an invalid stored value falls back to it. |
| `tools` | Tool name → `read` \| `write` \| `send` \| `money` \| `off` \| `hub`. **Unlisted tools are hidden**, so a new package version cannot add a tool nobody classified. |
| `docs` | `{ "homepage", "revoke" }`; `revoke` says how to cut access at the provider. |
| `catalog` | Optional, for the catalog on the page: `{ "verified": "YYYY-MM-DD", "api": "up to 40 characters", "official": true \| false }`. `verified` must be a real date, not in the future. Invalid values make the module "broken". |
| `health` | Optional: `{ "check": "<name of a check exported by index.js>" }`. Switched-on modules with a health check are checked every night (see Health check below). |
| `backup` | Optional boolean. `true` makes the module a place the hub can keep backups (see Backup modules). |
| `oauth` | Needed by a `signin` step: `{ "flow": "device", "deviceUrl", "tokenUrl", "scopes": [...], "clientIdSecret", "clientSecretSecret", "refreshTokenSecret" }`. Both URLs must be `https`; the three secret names must be declared in `secrets`. |

The API and the lists show `catalog` (or null), `health` (true when a check is declared), `hasGuide` (true when the
folder has `guide.md`) and `lastCheck`.

Tool classes map to the hub's tool policy: `read` → reading outside, `write` → writing outside, `send` → sending,
`money` → money (allowed only for agents named in `settings.walletAgents`; the module's `guard()` sets the limits).

The `hub` class is for tools the hub itself calls (through `connectors.callTool`, so still through the guard, which
runs `guard()` and writes the call to the activity log as a non-read call). Agents never see a `hub` tool: it is left
out of `tools/list` and of every agent's tools.

## Backup modules

`"backup": true` marks a module that can store the hub's backup files. It must declare these four tools, each with
class `hub` (otherwise the module is broken). Results are text holding JSON; a failure comes back with `isError` and a
plain message.

| Tool | Arguments | Result |
|---|---|---|
| `backup_put` | `{ file, name }` (`file` is a path on the hub's disk) | `{ name, size, md5 }` |
| `backup_list` | `{}` | `{ files: [{ name, size, created }] }` |
| `backup_delete` | `{ name }` | `{ deleted }` |
| `backup_get` | `{ name, out }` (`out` is a path to write) | `{ size, md5 }` |

`getModules().backupModules()` lists `[{ id, label }]` for backup modules that are finished and switched on (ready, or
needing attention after a failed check but still on). `connectors.callTool(id, tool, args, { timeoutMs })` takes a
per-call wait for slow calls such as an upload; without it the 60 s default applies.

## setup.json

`{ "steps": [ ... ] }`, last step `finish`. Each step has `id`, `type`, `title`, `body` (plain text; `**bold**`,
`- ` and `1. ` lists), optional `links` (`https` only) and `optional: true`.

| Type | What the page shows | Fields |
|---|---|---|
| `explain` | Text, Continue | `confirm` (a tick box the user must tick) |
| `outside` | Instructions for something done on another site, links, a tick box | `links`, `confirm` |
| `install` | Installs the npm package (scripts off) and creates the connector | |
| `secrets` | Password fields, or a key-file upload | `fields` (secret names), `keyFile: { "label", "fields": { "SECRET": ["json", "keys", "to", "try"] } }` |
| `check` | Runs `checks[check]` from index.js through the guard and shows the result | `check` |
| `settings` | A form for some settings | `fields` (setting keys) |
| `grant` | Pick agents (see Who can use a module). Money modules: wallet agents only; member agents never | |
| `signin` | "Sign in" with a short code shown to the person (OAuth device flow). Needs the `oauth` block in module.json and the client ID and secret saved first (an earlier `secrets` step). Done when the sign-in succeeds | |
| `finish` | Switches the module on when every non-optional step is done | |

### Sign-in (`signin` step)

Admin-only routes: `POST /api/modules/<id>/signin/start` replies `{ userCode, verificationUrl, intervalSec, expiresAt }`
(never the device code, which stays in the hub's memory; one pending sign-in per module); `POST .../signin/poll`
replies `{ status: 'pending' }`, `{ status: 'ok' }` (the refresh token is saved into `refreshTokenSecret` and the step
is marked done), `{ status: 'denied' | 'expired', message }`, or 409 "Start the sign-in again." Tokens and codes are
never logged or sent to the page. The provider is not asked before the polling interval has passed.

## Who can use a module

The flagged lead agent (`lead: true` in data/agents.json) can always use every module; other agents only when listed
in the module's connector. A lead that is not listed gets no money tools. `setAgents(id, names, { by })` on the
modules instance (used by the `grant` step) stores the list through the module path. It refuses unknown agents,
member-owned agents, temporary workers and, for a money module, agents that are not wallet agents; leads are dropped
from the list silently.

## Health check

With `health.check` declared, `lib/modules/health.js` runs that check every night (the hub's night window; also at
any hour once the last look is 48 hours old) for each module that is finished and switched on, one at a time. A
thrown error counts as a failed check. When a module goes from passing (or never checked) to failing, admins get one
phone notice ("<name> needs attention", opening `/modules#<id>`); a notice that reached no device is retried on the
next hourly tick, and the marker is cleared when the check passes again. A module that failed stays on the list
until it passes. State: `data/modules-health.json`.

Ask Maestro: `GET /api/modules/<id>/help?step=<step id>&error=<text>` (admin) answers `{ agent, message }`: the first
lead agent and a ready-made help request (it names the step and the error shown, and `modules/<id>/guide.md` when the
folder has one). The page sends it to that agent. No lead: 409.

## index.js

```js
module.exports = {
  checks: {
    // ctx: { callTool(name, args) -> text, settings, parse(text) -> object|null }
    async credentials(ctx) { return { ok, summary, lines: [], warnings: [], ackRequired: null | 'text the user must accept' }; },
  },
  // Runs in the guard process before every tools/call. ctx: { settings, usage (today's totals), callTool, callText,
  // fetchJson, manifest }. Return { allow, reason, record: { counter: amount }, args (tightened), note, quietResult }.
  async guard(call, ctx) { return { allow: true }; },
};
```

Guard rules: refuse what you cannot size or do not recognise (fail closed); refuse fields you do not check;
`record` amounts are reserved before the call goes out and given back only on an explicit failure; money calls run
one at a time; every non-read call is written to `data/modules/<id>/audit.jsonl` (secret values are blanked).
A money module without `guard()` cannot use its money tools.

## Tests

`test/modules.test.js` validates every folder in `modules/`. Add tests for your guard's rules there, and a fixture in
`test/fixtures/modules/` if the module needs a fake server.
