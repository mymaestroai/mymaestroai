# Modules: how to add one

A module is an optional capability (an exchange, a mail account, a search service...) that an admin adds from the
**Modules** page with a guided setup. One folder per module; the hub core never names a module.

```
modules/<id>/
  module.json   what it is, its risk, what it needs, secrets, settings, tool server, tool classes
  setup.json    the guided setup, step by step
  index.js      optional: checks for "check" steps, guard() for per-call limits
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
| `tools` | Tool name → `read` \| `write` \| `send` \| `money` \| `off`. **Unlisted tools are hidden**, so a new package version cannot add a tool nobody classified. |
| `docs` | `{ "homepage", "revoke" }`; `revoke` says how to cut access at the provider. |

Tool classes map to the hub's tool policy: `read` → reading outside, `write` → writing outside, `send` → sending,
`money` → money (allowed only for agents named in `settings.walletAgents`; the module's `guard()` sets the limits).

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
| `grant` | Pick agents. Money modules: wallet agents only; member agents never | |
| `finish` | Switches the module on when every non-optional step is done | |

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
