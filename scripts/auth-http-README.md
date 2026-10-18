# Direct authenticated HTTP testing

Implemented in `lib/tools/auth-http.js`.  Shared Hub tools are `auth_http_status` and `auth_http_request`, loaded with category `auth_http`.  The Hub injects the calling agent slug; it is not an LLM-supplied argument.

## Current state

The implementation and offline tests are installed.  The private configuration is initialized but disabled, with no identities or routes.  A Hub restart is required to load the new built-in tools.  No live application requests, credential exports, browser extraction or security tests were performed during implementation.

No deployment-specific authentication flow is included.  Configure reviewed routes locally.

## Provisioning workflow

1. Identify the exact in-scope HTTPS origin and a read-only JSON identity endpoint using application documentation or a known request from the dedicated test account.  Confirm the response has a stable identity field.  Its JSON pointer and expected value become the authentication probe.  A public health endpoint or a generic `authenticated: true` response is not sufficient.
2. Edit `~/.config/agent-hub-http/config.json` locally.  Keep `enabled:false` until review is complete.  Define named identities, exact reviewed routes, the allowed agent slugs, query keys, request budget and expiration.  The examples below illustrate the schema only and are not the organization endpoints.
3. Provision each dedicated test identity through a supported local credential source.  The executor accepts literal HTTP headers, including Authorization, Cookie, Origin, Referer and a required CSRF header.  There is no automatic login, cookie extraction, browser dependency, signing protocol or refresh flow.  Cookies are pinned to one exact origin, rather than sharing browser domain scope.  Do not paste passwords, cookies, tokens, HAR files or authenticated cURL commands into chat.
4. Put identity JSON in a protected local file outside repositories, then run `node scripts/auth-http.js import-identity NAME < /absolute/path/to/protected-identity.json` from a human-operated terminal.  Never put credentials directly on the command line.  Alternatively edit the private `identities.json` directly.  Ensure directory mode 0700 and file mode 0600.  Remove temporary credential material when finished.
5. Run `node scripts/auth-http.js validate`.  This checks local configuration and credential expiry only; it sends no network requests.  Review every route including GET routes, since GET is not a guarantee of no side effects.  State-changing methods, including GraphQL POST, require a nonempty human approval note in config.  This note records review, it is not a tamper-proof approval system.
6. After the Hub has loaded the implementation, enable the reviewed run by locally setting `enabled:true`.  Ask the agent to load `auth_http`, inspect status and request the probe route first.  A successful probe proves the configured stable identity was returned at that point.  It does not prove that every target endpoint enforces authentication.
7. Use two separately provisioned accounts for cross-account tests.  Limit object IDs and other parameters to objects and identities covered by the approved test.  Agents can vary parameters, but cannot supply arbitrary destinations, auth headers, methods or GraphQL documents.
8. Stop with `node scripts/auth-http.js disable`.  In-flight requests can finish; subsequent requests, including a target after an in-flight probe, are blocked.  Revoking the source credentials is the stronger stop if immediate revocation is required.

Commands are run from the Hub root.  `init` refuses to overwrite an existing setup.  `status [agent-slug]` shows scope without reading credentials.  There is deliberately no tool to enable a run, expand scope, reset a halt or export credentials.

## Configuration schema example

The `.invalid` host and endpoint names here are intentionally nonfunctional.  Replace them using verified application information, not guesses.

```json
{
  "version": 1,
  "enabled": false,
  "runId": "reviewed-test-run",
  "expiresAt": "2030-01-01T00:00:00Z",
  "maxRequests": 100,
  "requestsPerMinute": 30,
  "concurrency": 4,
  "timeoutMs": 15000,
  "maxResponseBytes": 65536,
  "identities": {
    "test-a": {
      "origin": "https://application.invalid",
      "probe": { "route": "identity-probe", "pointer": "/user/id" }
    }
  },
  "routes": {
    "identity-probe": {
      "origin": "https://application.invalid",
      "path": "/verified-identity-endpoint",
      "method": "GET",
      "identities": ["test-a"],
      "agents": ["main", "example-agent"],
      "queryKeys": [],
      "reviewed": true
    },
    "object-read": {
      "origin": "https://application.invalid",
      "path": "/verified-object-endpoint/{id}",
      "method": "GET",
      "identities": ["test-a"],
      "agents": ["main", "example-agent"],
      "queryKeys": [],
      "reviewed": true
    }
  }
}
```

Use a short real run expiry, not the example date.  Every route's agents and identities must also be allowed to use its corresponding probe.  Placeholder values accept only alphanumeric characters, underscores and hyphens.  Static paths cannot contain query strings, encoded characters or dot segments.

For a GraphQL route, set method POST, add a human `approval` string and a `graphql` object with `document` and `operationName`.  The document is fixed in reviewed local configuration; agents supply only `variables`.  This avoids fragile regex checks that confuse read queries, mutations, comments, aliases and batched operations.  To test a different document, review and configure another route.  Generic POST/PUT/PATCH/DELETE routes accept JSON bodies only.

Private identity JSON uses these fields:

- **headers:** An object of real locally provisioned HTTP header values.  The executor never takes these as tool arguments or returns them.  These may include a session cookie and CSRF header when verified as required by the application.
- **expectedIdentity:** The stable string or number expected at the probe's JSON pointer.  Probe bodies are always withheld from output and evidence.
- **expiresAt:** A short future ISO timestamp.  Automatic refresh and Set-Cookie rotation are not implemented.  Changed or expired credentials block subsequent requests.

## Runtime behavior and evidence

- One shared executor instance per Hub process.  Up to 8 concurrent operations; default initialized setting is 4.  A full slot rejects with a retry-later error instead of building an unbounded queue.  The global tool scheduler recognizes both tools as parallel-safe because the executor applies its own bound.  Approved writes may therefore overlap; set concurrency to 1 for order-sensitive work.
- Every test starts with an identity probe.  Probes count against both rate and total budgets.  Total budget and rate counts live in private SQLite and survive restarts.  An exhausted run is not reset automatically.  A human-reviewed new run ID is required for a new budget.
- Origins use exact HTTPS matching.  Credentials are never forwarded across redirects.  DNS must resolve to public IPv4 addresses; selected results are pinned to the TLS connection and normal certificate validation remains enabled.  Internal/VPN-only targets and IPv6-only hosts are not supported by this implementation.  Do not weaken the public-address check to make such a target work.
- Request bodies are capped at 64 KiB, URLs at 8192 characters and raw response bodies at the configured maximum, capped at 256 KiB.  Responses are streamed into a bounded buffer.  DNS and HTTP each have bounded timeouts.  HTTP keep-alive pooling is deliberately disabled for this first implementation; browser automation and LLM-per-click overhead are removed, but HTTP throughput has not been benchmarked.
- A transport error, failed identity probe, HTTP 401, redirect or HTTP 429 halts the entire run.  Known GraphQL authentication error codes and unexpected successful non-JSON responses also halt it.  Concurrent requests already on the wire may finish.  HTTP 403 on a test is preserved as evidence because authorization-denial comparisons are useful; a probe returning 403 fails.  Application-specific HTTP-200 JSON auth failures beyond the recognized codes are not universally detectable.
- Each sent request gets an evidence UUID and reserved SQLite row before network execution.  A crash may leave an incomplete row, which still consumes budget.  Results include probe correlation, status, latency, byte count, an allowlisted subset of response headers, redacted request parameters and redacted JSON response data.  Request previews are capped at 8000 characters and response previews at 24000.  Truncation is marked.  There is no automatic replay or retry.
- Evidence lives in `~/.config/agent-hub-http/evidence.sqlite`, outside source repositories.  It is not an immutable audit log.  Failed requests currently retain route/identity metadata and error/status, not the full parameter reproduction.  Successful calls retain redacted parameters.  Normal Hub tool-call logs also retain agent-supplied arguments, which is why secrets must never appear there.

## Security boundary and limitations

This is an application-level controlled executor, not a sandbox against agents with unrestricted Bash/Read/Write tools running under the same macOS UID.  Such agents can access private files, change configuration, invoke their own clients or reset evidence.  A separately permissioned broker plus restricted agent execution is necessary for isolation from a compromised agent.  Do not describe local file permissions as protecting secrets from same-user agents.

Redaction is defense in depth, not a proof that arbitrary application output contains no sensitive data.  It removes known credential values, URL/base64 representations, common credential field names, JWT-shaped strings, email addresses and selected personal/account fields.  Unknown opaque secrets in innocuous fields or custom encodings may survive.  Only dedicated test-account data should be in scope.  Non-JSON response bodies and sensitive headers are withheld.  This tool is intentionally not an HTML/XSS renderer or a complete web scanner.

Review references to object ownership and allowed test identities separately from endpoint scope: a reviewed route still permits varying its approved parameters and JSON body.  The executor does not know which object IDs represent controlled accounts unless they are fixed in the configured path/document.

## Offline tests

```bash
node --test test/auth-http.test.js
node --check lib/tools/auth-http.js
node --check lib/provider-tools.js
node --check lib/sdk-chat.js
```

Tests use temp directories and mocked network transports.  They never contact the organization, resolve a real test target or consume production credentials.  Passing these tests is not live authentication or production-readiness validation.
