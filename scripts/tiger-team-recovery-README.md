# Tiger Team recovery

Implemented for led Tiger Teams and roundtables.  Backend activation requires a normal Hub restart.  Do not restart without the operator's approval.

## Operator workflow

- Transient model connection errors, throttling, and 5xx failures trigger up to three additional attempts per agent call, with jittered exponential backoff.  Retry waits share a 90-second ceiling.  A long Retry-After that exceeds the remaining wait budget pauses instead of hammering the provider.
- Retry notices show attempt and delay in the war room.  Exhausted retries leave a recoverable interrupted/blocked state, never a successful completion.
- Use **Resume Interrupted** to resume the original work.  Use **Continue** to start a new directive after completion.
- The canonical investigation ID is saved in the browser URL.  Refresh loads that investigation instead of automatically starting another one.  Unexpected browser disconnect requests a targeted stop (start has an eight-second grace period); Resume waits for the previous execution to unwind.  There is no background reattachment or automatic replay of the Resume POST.
- Saved sessions include durable checkpoints.  These remain available after a process restart.
- Authentication, permissions, configuration errors, and required-data-source outages need attention rather than automatic tool retries.  Restore the dependency before Resume.

## Guarantees and limits

- `lib/tiger-team-recovery.js` owns atomic checkpoints in `data/tiger-team-checkpoints/<id>.json`.  Files are mode 0600.  Runtime HTTP responses, controllers, and locks are excluded.  Temporary files are fsynced and renamed over the prior checkpoint; directory metadata is synced too.
- Checkpoints retain prompts, tool results, call journals, investigation metadata, loaded tool categories, challenger state, and continuation state.  Every model chunk is appended and fsynced to an event journal before display.  Checkpoint recovery replays committed deltas after its saved sequence watermark.  Partial tool-call arguments are retained as evidence but are never executed as completed calls.
- Each dispatch has its own stable ID.  Recovery reuses completed call results; a separate later dispatch with identical text is not silently deduplicated.
- Completed tool results are restored without re-executing the original calls.  A tool recorded in flight with no durable result has an unknown outcome.  Resume, Continue, and the tool loop are blocked until the operator records a verified result and supporting evidence using Resolve Unknowns.  Agent consultations instead resume through their own stable call journals.  External exactly-once execution cannot be guaranteed when a remote operation finishes before its result reaches durable storage.
- Tools are not automatically retried by this layer.  Only model generation is retried, before executing any newly generated tool calls.  Truncated tool-call arguments are retained in the raw journal for inspection, but discarded from executable plans.
- Led coordinator, participant, challenger, and final-synthesis calls all use the journal.  Roundtables retain completed contributions and resume the interrupted contribution.
- Resume/Continue reservations reject duplicate requests with HTTP 409.  Stop targets its own team, retains the reservation until execution unwinds, and uses a fresh abort controller on resume.  Tools that do not support cancellation may finish before the team can be resumed.
- Existing saves made before this implementation have transcript-only recovery.  They cannot retroactively acquire tool journals; the UI explicitly warns about the weaker guarantee.
- Checkpoints contain local investigation data, including tool inputs/results.  They are owner-readable and not encrypted by this feature.  There is no automatic expiry; explicitly deleting an inactive durable saved team removes its checkpoint, event journal, and artifacts.  Ordinary pruning only evicts the in-memory copy.
- Context-limit and invalid-configuration failures are not automatically repaired.  This layer preserves context rather than silently discarding evidence to make a request fit.
- `completedAt` is a legacy execution-ended timestamp, not proof of success.  Check `status === 'completed'` for success.

## Implementation

- `lib/sdk-chat.js`: owned in-process TT turns replace ambiguous localhost self-call replay for journaled work; structured failure propagation, model-only retries, tool journaling, durable orchestration and resume.
- `lib/gateway-client.js`: `noRetries` lets the TT caller own one bounded retry budget instead of multiplying gateway and orchestrator retries.  Normal chat retains its prior policy.
- `server.js`: shared Resume/Continue handler, targeted Stop/disconnect, durable saved-session/status views.  Failed investigations cannot reach alert completion/soft-close processing.
- `tiger-team.html`: Resume button, retry/interruption display, canonical recovery URL, EOF detection, saved-state recovery.

## Verification

Offline tests extract actual production functions into isolated VM contexts, with fake gateway streams and tools.  No production server import or real investigation is required.

```bash
node --test test/tiger-team-*.test.js test/auth-http.test.js
node scripts/test-parallel-tools.js
```

At implementation time: 67 node tests passed (25 new recovery tests and 42 related regression tests), plus 61 tool-parallelism checks.  Syntax checks passed for all changed JavaScript and inline UI scripts.

Still required after an approved restart: live war-room smoke test, real gateway disconnect/recovery, and browser refresh/Resume confirmation.  Tests do not establish live activation.


## Forward preservation upgrade (2026-09-21)

Implemented on disk, NOT activated or live-validated.  Do not restart without approval.

- Each investigation owns a checkpoint, append-only `.events.jsonl` journal, and content-addressed `.artifacts/` directory.  Files are mode 0600; directories 0700.  Artifacts are SHA-256 verified on retrieval.  Committed corrupt records fail closed; a torn, unacknowledged final line is repaired before appending.
- Stream events include original provider chunks, incomplete tool deltas, usage, available reasoning events, UI events, model-request snapshots, and orchestration events.  This captures data actually delivered to Hub, not private provider state or output the provider never returned.
- Tool invocation arguments, exact returned results, status, full pre-preview built-in outputs, and raw MCP content are retained.  Auth HTTP capture uses ONLY already-redacted evidence; credentials and intentionally withheld bodies remain withheld.  Normal model-context limits still apply, but do not delete the archive.
- Cache spill files are read into the TT result before the cache can expire.  No claim is made that historical cache entries contain raw fields their original tool already discarded.
- Pending user injections are saved before HTTP acknowledgment, restored across session rebinding, and consumed atomically with working messages.  Follow-up directives and roster changes are retained.
- `read_tiger_team_archive` is available to TT agents, scoped to their investigation.  It provides an index, paged calls/tool results/artifacts, and paged raw events through `events_after`.  Follow-up context previews are explicitly labeled and point to exact preserved evidence rather than forcing the whole archive into a finite context window.
- **Full Record** downloads state, events, and artifacts as JSON.  **Resolve Unknowns** records operator-verified outcomes with evidence.  Merely clicking Resume cannot silently bypass uncertain operations.
- Persistence failure halts progress instead of acknowledging unsaved work.  This is not protection against disk loss, filesystem corruption, intentional deletion, or provider-side loss before delivery.  Existing backup/restore remains necessary.
- Tool/source limits remain real: Bash currently has a 1 MB subprocess capture limit; requested query/page/file limits still limit what a source returns.  The archive cannot invent output beyond those limits.  Other tools that produce summaries internally may expose only those summaries.  Preserve received evidence; do not promise access to data that was never captured.

### Upgrade verification

- 85 targeted Node tests passed, plus 61 tool-parallelism checks and syntax validation.
- Includes real child-process SIGKILL tests at the journal layer AND the actual production tool-loop function with a fake gateway.  The tool-loop kill occurs after a completed tool and displayed partial text; recovery retains both and does not replay the tool.
- Also covers storage failure before display, partial journal tails, corruption refusal, artifact checksums, exact paging, directive recovery, unknown-outcome gates for both Resume and Continue, and full-record JSON export.
- No working-Hub restart, live gateway call, or live Tiger Team was used for upgrade validation.  Actual browser smoke tests and production storage/latency observation remain outstanding.
