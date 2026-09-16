# Wire Team Bot — App and Delivery Plan

Updated: 2026-09-16. Release runtime: `2ba7a1f` (baseline `e35428b`).

This is the single source of truth for the app, feature scope, architecture and delivery
progress. The next version is a **real-world pilot of the existing bot**, with targeted
reliability fixes. It is not a rewrite or a commitment to every former V3 proposal.

[README.md](README.md) covers setup and operation. [AGENTS.md](AGENTS.md) covers contributor
rules. Update progress here; do not create another versioned plan or gap backlog.

## 1. What we are building

Wire Team Bot is a Wire participant that helps a team remember decisions, keep track of commitments,
and catch up on work without maintaining a separate record by hand.

| Team need | Useful outcome | Pilot boundary |
|---|---|---|
| Capture | Record a decision, action, owner or reminder from the conversation. | Explicit commands plus the existing passive extractor; tolerate conservative capture. |
| Recall | Answer what was decided, why, by whom and when, using the team's record. | Current channel only; say when the available record cannot answer. |
| Progress | See open/overdue work, mark it done, change an owner or deadline, receive reminders. | Existing action lists, updates, nudges and summaries; no new project-management system. |
| Control | Know when Wire Team Bot is listening and stop processing sensitive discussion. | ACTIVE / PAUSED / SECURE, with verified context isolation. |

The pilot should answer: **does this save the team work, with sufficiently few mistakes and
interruptions that they choose to keep using it?** A large feature count is not a success measure.

Product rules:

- Keep the common tasks easy to express. Add natural-language variants when observed usage
  fails; a new intent framework is not a prerequisite for testing.
- Confirm actual writes, owners and deadlines. Do not imply an action happened when it did not.
  Ask a short clarifying question when a consequential choice is ambiguous.
- Keep `DEC-`, `ACT-` and `REM-` references for reliable corrections during the pilot. Removing
  them requires a proven replacement, not a blanket presentation change.
- In groups, teach users to mention Wire Team Bot for questions and use the documented commands for
  changes. Existing unmentioned follow-ups are a heuristic, not a general conversation contract.
- Keep passive capture quiet. Fix misleading prompts and dead controls before adding new ones.
- Retain the existing Wire Team Bot voice: concise, no exclamation marks, “I'm afraid” rather than
  “Sorry”, “Shall I” for a supported offer. Accuracy matters more than persona polish.

## 2. Architecture and data contract

Keep the existing hexagonal architecture and repository layout.

| Layer | Location | Allowed dependencies |
|---|---|---|
| Domain | `src/domain/` | Domain only; entities and repository/service contracts |
| Application | `src/application/` | Domain and ports; use cases, no SDK/DB/LLM clients |
| Infrastructure | `src/infrastructure/` | Domain, application and external libraries |
| App | `src/app/` | All layers for configuration and composition; no business logic |

Runtime: TypeScript/Node, official `@wireapp/wire-apps-js-sdk`, Prisma, PostgreSQL + pgvector,
one bot process. Keep the in-memory processing queue and scheduler. No new service or
production dependency is required by this plan.

### Message processing and retrieval

- Ambient ACTIVE messages pass through classification, extraction and embedding. Explicit commands and Q&A do not also enter passive extraction; embeddings and contradiction checks are awaited as part of the cancellable job.
  `InMemoryProcessingQueue` allows five concurrent channels, serialises work within each channel, and holds 500 queued jobs; overflow drops
  the oldest queued job with a warning. Transient processing and buffers are lost on restart.
- Extraction uses a 30-message sliding window. Q&A uses a separate
  `ConversationMessageBuffer` (default 50, configured maximum 500). Both matter for privacy.
- Structured decisions/actions, entities/relationships, signals and summaries form the durable
  record. Tasks were consolidated into actions; `KnowledgeEntry` was retired.
- Questions go through query analysis, then structured, semantic, graph and summary retrieval.
  Paths run with `Promise.allSettled`; results merge using reciprocal rank fusion, a 1.5×
  multi-path boost, recency and confidence, within an approximate 7,000-token budget.
  Graph traversal is bounded to depth three. Temporal/institutional queries add summaries.
- Commands are currently pattern-based in `WireEventRouter`. The old foreground
  `OpenAIConversationIntelligenceAdapter` is absent. Configuration now reads `JEEVES_*`;
  the old `LLM_PASSIVE_*` / `LLM_CAPABLE_*` variables are not read by `config.ts` and do not
  power a second router. The compatibility `ConversationConfigRepository`
  still reads from `channel_config`.
- Reminders persist in Postgres and are rehydrated after Wire initialisation. Daily summaries
  run at 08:00 UTC, weekly summaries Monday 08:00 UTC, staleness checks every six hours.
  These are current schedules, not the old proposed per-channel-timezone schedules.

Code references: [composition](src/app/container.ts),
[pipeline](src/infrastructure/pipeline/ProcessingPipeline.ts),
[retrieval](src/infrastructure/retrieval/MultiPathRetrievalEngine.ts),
[schema](prisma/schema.prisma), [migrations](prisma/migrations).
Schema and configuration details belong in those files rather than a second SQL specification.

### Privacy and access requirements

These are requirements; the implementation gaps in §3 must be resolved before using sensitive
team conversations.

- **Extract-and-forget:** do not persist surrounding raw conversation text in records, signals,
  audit payloads or diagnostic logs. Store the requested decision/action/reminder content,
  structured extractions and source IDs/timestamps. Structured knowledge is still sensitive;
  this is not a claim that retained information cannot reveal a conversation.
- Wire Team Bot sees decrypted messages as a Wire participant. Model requests go to the configured
  providers. On-premises processing requires both chat and embedding endpoints to be local;
  Wire encryption does not keep content away from a configured external model provider.
- **ACTIVE:** normal processing. **PAUSED:** stop ambient processing; accept supported control
  commands. **SECURE:** also clear transient context. Messages received while paused/secure
  must not leak into later prompts. State transitions must account for both buffers and queued
  or in-flight work, and state persistence failures must not silently re-enable processing.
- Scope every retrieval and mutation to the qualified conversation ID, including direct ID
  lookups. `channel_id` is `{conversationId}@{domain}`; Wire domain supplies organisation ID.
  No cross-channel recall in the pilot. The router detects personal mode and passes `userId`,
  but current retrieval paths do not implement the old promised org-wide personal view.
- Treat LLM output as untrusted. Validate types, bounds, identities and allowed transitions
  before persistence. Audit domain changes through `AuditLogRepository`.

### Models and deployment decisions

Seven slots remain: `classify`, `extract`, `embed`, `summarise`, `queryAnalyse`, `respond`,
`complexSynthesis`. Six chat slots share an OpenAI-compatible endpoint; embeddings can use
a separate endpoint or be disabled. Use [config.ts](src/app/config.ts) for actual defaults and
[README configuration](README.md#environment-variables) for operations. Do not choose a new
provider framework for the pilot.

The current embedding column and default are **2560 dimensions**. The latest dimension
migration removed the HNSW index; current search is exact cosine search. Match the configured
model, fallback and database dimensions. Enabled configuration must use 2560 dimensions; primary and fallback responses must contain finite vectors of that size. This checks configuration/output, not a live startup model probe or schema migration. Vector features need a separate smoke test if enabled;
structured recall and summaries must remain useful with embeddings off.

The official SDK migration keeps CommonJS, the `node:22-trixie-slim` image and a persistent
`/app/storage` keystore. Its staging report is historical evidence, not production sign-off.
Preserve the existing crypto key and store across ordinary restarts. See the
[cutover runbook](README.md#official-sdk-cutover) for migration from the old fork.

## 3. Current delivery state

**Implemented** means code is present, not that it is proven in a real team. **Reported** means
an earlier document records a run. **Pending** means this plan has no acceptance evidence.
The old v2 phases 1a, 1b, 2, 3 and 4 describe delivered components, not a completed pilot.

| Capability | State and evidence | Remaining acceptance |
|---|---|---|
| Wire connection, send/receive, persisted crypto | Implemented; staging success and restart reported on 2026-09-16 during SDK migration | Repeat on the pilot image; production cutover pending |
| Explicit decisions, actions and reminders | Implemented; use cases and contract/e2e scenarios present | Verify attribution, changes and reminder delivery on Wire |
| Passive capture and natural completion | Source replay guards, exact active-fact dedup, validated owners and completion updates implemented | Stored-record evaluation available; human quality review pending |
| Questions and channel summaries | Implemented; retrieval and summary tests present | Validate known-answer questions, empty results and provider degradation |
| Action lists, staleness nudges, scheduled summaries | Implemented | Judge usefulness/noise; verify restart and overdue behaviour |
| Pause, resume, secure and access scoping | Both buffers clear on pause/secure; queued jobs discarded, in-flight work cancelled/drained; qualified access checks and fail-closed state reads/writes tested | Synthetic DB/log and restart markers pass; designated Wire smoke required |
| Embeddings optional/separate provider | Implemented; embedding configuration tests present | Smoke test selected configuration and dimensions |
| Buttons and contradiction follow-through | Dead decision buttons removed; old clicks and contradiction notices give text commands; Q&A prompt explicitly read-only | Human/Wire review of actual interactions pending |
| Test harness and simulation | Event-framed CLI, post-drain DB inventory and fact/source scoring implemented; simulation now sends the fixture’s actual members | `golden.json` still has no human review; no human-approved quality claim |
| Product name | User-facing name is Wire Team Bot; old text prefix and `JEEVES_*` environment keys remain compatibility aliases | Verify registered Wire app display name in smoke test; generic name configuration remains deferred |
| Documentation consolidation | Complete in this revision | Maintain this plan as work lands |

Historical validation: SDK migration notes reported 141 passing unit tests, clean lint, an
offline CLI smoke run, and then staging connectivity/restart success. Those notes also contain
an older “not exercised yet” entry, superseded by their staging update. Those historical results are separate from the fresh candidate evidence below.

### Consolidation findings and implemented remedies

| Finding | Remedy in the candidate | Validation boundary |
|---|---|---|
| Raw surrounding context persisted in signals/decisions and diagnostics | Decision context is empty; low-signal/failure signals contain generic activity metadata; model/output previews and HTTP error bodies are not logged. SDK messages/metadata (including nested decrypted events) are reduced to severity-only diagnostics; startup failures do not log exception bodies. Arbitrary extractor metadata is discarded. Channel purpose requires an explicit context command. | Synthetic marker checks; historical rows have not been altered or scrubbed. Start the pilot with approved data, not an assumed-clean legacy database. |
| Pause/secure leaked through buffers and background work | Both buffers clear; per-channel jobs cancel and drain before confirmation; events serialize; blocked-period messages are never buffered; hydration/resume failures stop processing locally. | In-flight requests already sent to a provider cannot be recalled. A failed durable state write is explicitly reported and must be retried before restart. |
| Explicit-ID access bypassed qualified scope | Structured and semantic source lookups verify ID **and domain**, as do affected mutations; deleted targets are rejected. | Unit negative tests and isolated Postgres retrieval tests. |
| Buttons and Q&A promised unsupported writes | Removed decision yes/no prompt; text alternatives for old buttons and contradictions; Q&A is explicitly instructed that it cannot write. | Model instructions cannot guarantee every generated answer; review remains required. |
| Malformed model results and provider compatibility | Root/type/confidence/length validation, bounded arrays, known-owner/known-action checks, finite embedding dimensions; bounded retry without temperature only on an explicit unsupported/deprecated-parameter rejection. | Model fallback and output-degradation events remain visible in reports. |
| Reminder could be lost on send failure | Fired state follows successful send; failure retains pending state and schedules a 60-second retry; restart rehydrates pending overdue records. Duplicate local callbacks are suppressed; long timers avoid Node overflow. | At-least-once delivery: a crash between send and durable acknowledgement can duplicate a reminder. Single process only. |
| Reply-ID simulation scores omitted silent captures | CLI acknowledges drained source events; evaluation queries all channel decisions/actions after exit, matches facts plus source/owner, and counts duplicates as errors. Simulation uses the same inventory and actual fixture senders. | Fixed sample and model judging assist review; neither replaces human capture/Q&A approval. |


## 4. Next version: bounded pilot work

A change enters this release only if it fixes a reproduced user problem, closes a privacy or
correctness gap, or supplies evidence needed to decide whether the bot is useful. Each change
needs a scenario, the smallest viable fix and an observable acceptance result. “The old branch
implemented it” is not evidence of value. Do not cherry-pick a subsystem without that test.

Start with a short baseline, then fix P1 before broader reliability tuning. P0 and P1 use
synthetic data; real team content waits for P1 to pass. Missing model access or human review
must not delay reproducible privacy/access fixes. Finish independent work and record the
remaining validation dependency explicitly.

| ID | Work and direct value | Acceptance evidence | Progress |
|---|---|---|---|
| P0 | Establish baseline using existing fixtures, isolated DB inspection and the intended model configuration. | Stable expected facts including missed/silent captures; reviewed precision/recall, duplicate count, ten known-answer questions, response times and failures. Record commit, configuration and date; do not rely on printed IDs alone. | Automated sample complete; human review pending |
| P1 | Close the concrete data-retention, state-isolation and access-scope gaps in §3. | DB/log inspection with synthetic marker text; pause/secure/resume tests for both buffers and queued work; cross-channel and cross-domain retrieval/mutation denial tests. Review audit coverage on affected writes. | Implemented and automated regressions pass; Wire acceptance pending |
| P2 | Make existing user journeys dependable. Verify names after restart, reminder downtime/send-failure recovery, corrections, model failures, and text alternatives to dead controls. | Required journeys in §5 pass on CLI and Wire. Fix duplicate or malformed-output failures locally when reproduced. No unsupported “Shall I…?” or inert required button. | Implemented; real-model regression 54/56, two adjudications and Wire acceptance pending |
| P3 | Run one small team pilot and decide the next investment. | Five working days of use, short feedback log, counts against §5 and a keep/fix/stop decision. At most three evidence-backed follow-ups. | Pending |

Small fixes may touch validation, deduplication, prompts or command variants. They do not imply
a general intent executor, a new schema library, vector dedup across every write, or scheduler
replacement. If the existing baseline is adequate, proceed to the pilot without feature work.

### Development goal and finish line

**Build Wire Team Bot v3 as a tested release candidate for the small team pilot: close P1, complete
P0 and P2 acceptance, preserve the current architecture, and deliver reproducible evidence
that capture, recall, actions, reminders and privacy controls work on the chosen deployment.**

The development deliverable is:

1. Small, reviewable fixes with regression tests for the gaps above. No unrelated feature or
   dependency additions; a failed scenario determines the next fix.
2. A fixed synthetic evaluation sample, expected facts/questions, actual stored results and
   before/after counts. Use the existing fixtures where possible. Review expectations before
   tuning prompts; do not improve scores by weakening assertions or ignoring missed captures.
3. Passing build/type-check, lint, unit/contract and isolated DB integration checks; relevant
   e2e failures reproduced and fixed, then the full e2e suite rerun on the selected models.
   Record model names, embedding mode/dimensions, commit and commands without credentials.
4. A reproducible container build from the tested commit, updated operating instructions,
   current Wire send/receive/restart/reminder smoke evidence, and a concise handover in this
   plan with known limitations and the next pilot step. Building an image is part of the goal;
   production cutover is a separate operator action using the README runbook.

“Code complete” means the implementation and available automated checks are finished.
“Pilot ready” additionally requires P0/P1/P2 evidence, including the selected provider run,
human review of quality, and the real Wire smoke test. A missing endpoint, account or reviewer
is a named pending acceptance check, never a passing result. Finish all independent work
before handing back a blocked check.

P3 is the subsequent five-working-day trial and human usefulness decision. It is not something
an unattended coding run can declare successful. The pilot operator supplies the team/channels,
approved provider configuration and human review; the developer prepares and fixes the candidate.
These are operational inputs, not reasons to invent additional product features.

Stop adding scope when P0–P2 pass. Record at most three evidence-backed follow-ups from P3.

### Disposition of the former V3 gaps

Old IDs are retained only to make the consolidation traceable. This table replaces that backlog;
“defer” is not a commitment for the following release.

| Former gap | Decision for this release | Revisit trigger |
|---|---|---|
| A1, D1 — natural-language commands/corrections | Test common variants; fix observed misses through existing use cases. Defer wholesale intent routing. | Repeated failed tasks caused by syntax, with examples |
| A2 — hide IDs | Keep references alongside readable summaries. | Users cannot complete corrections; a safer alternative has been demonstrated |
| A3 — ambiguity | Never guess a consequential owner/target; test duplicate names and unknown people in P2. | Add only the clarification needed by those cases |
| A4, A5 — voice/follow-ups | Measure misleading answers and misdirected replies; retain explicit group addressing as the taught path. | Repeated usability failures, not speculative conversational state |
| B1 — duplicate capture | Test explicit/mentioned commands, repeats and sliding-window overlap; add the smallest write/routing guard if failing. | Reproduced duplicates; no automatic adoption of Redis/hash/vector layers |
| B2 — malformed output | Exercise current validation/fallback; close unsafe writes or silent loss affecting the baseline. | Evidence that local validation fixes are inadequate before adding a framework |
| B3, B4 — attribution and implicit commitments | Verify names/restart and baseline extraction/completion. | Specific wrong owner, missed or invented completion |
| B5 — seed loader | Defer; use existing channel purpose and a few explicit starting decisions. | Pilot onboarding is materially blocked by missing context |
| B6 — attachments | Defer. | Important knowledge is repeatedly inaccessible because it exists only in files |
| C1 — retrieval replacement | Keep current paths; investigate failed known-answer questions. | Measured misses remain after small fixes; no LlamaIndex/reranker by default |
| C2 — explain empty results | Use honest wording for no result or a known failure; never invent a reason. | Add metadata only when required to distinguish an observed failure |
| C3 — embedding availability | Existing optional/separate endpoint is sufficient. | Chosen pilot requires vector features and their absence causes measured misses |
| D2, D3 — contradiction/acknowledgement/undo buttons | Repair or remove misleading existing prompts; use text corrections. Defer new workflow. | Users need frequent corrections that existing commands cannot support |
| D4 — durable jobs | Test existing Postgres reminder rehydration before redesigning. | Demonstrated missed/duplicate delivery not solved by a local fix |
| D5 — progress view | Try current open/overdue lists and summaries first. | Team cannot see what moved or is stuck; agree an example before building |
| D6 — quality/cost visibility | P0: annotate the baseline, count failures and time replies. Record provider usage if available. | Add per-slot counters only if needed; no dashboard/telemetry platform |
| E1, E2 — name/voice customisation | Not a pilot gate. | A real team is blocked by current naming/voice |
| E3 — footprint | Keep Prisma, pgvector, one process and no Redis. | Measured capacity or durability requirement |

Also deferred: mem0/second memory store, pgvecto.rs, ORM migration, general cross-channel
recall, org-wide personal recall, ESM conversion, horizontal scaling and unrelated cleanup.
No old-branch implementation is presumed approved for reuse.

## 5. Testing and release decision

Default pilot: one consenting team, one or two channels, five working days. Record the
operator, participating team, image/commit and chat/embedding configuration before starting.
Use synthetic data for acceptance first; do not copy real transcripts into the repository.

Required journeys:

1. Log and retrieve a decision, including why/when; revoke or supersede it using a supported command.
2. Capture an action for another named member; list, reassign, change its deadline and complete it.
3. Create/cancel/snooze a reminder; restart before it is due, test one becoming due during downtime,
   and simulate a failed send followed by recovery. Do not silently mark undelivered work successful.
4. Passively capture clear decisions/commitments without duplicating explicit commands or window context.
5. Answer ten questions whose answers are known from the record; an unknown question must not invent facts or writes.
6. Catch up on a channel and inspect open/overdue work; judge whether summaries/nudges help.
7. Pause/secure/resume across both buffers, queued work and restart; check no excluded text reaches prompts or storage.
8. Deny cross-channel and cross-domain access, including guessed record IDs and corrections.
9. Exercise malformed/truncated model output, timeouts and embeddings off; no invalid writes or crash.
10. Reconnect/restart on Wire; check decryption, member names and every interaction the pilot depends on.

Use `npm test`, `npx tsc --noEmit` and `npm run lint` for code checks. Run DB integration tests
with `INTEGRATION_TESTS=1` on an isolated Postgres instance. Build before the real-DB/LLM CLI,
e2e suite or simulation. These validate bot behaviour; a Wire-client smoke test is still needed
for SDK transport and client UI. Commands and harness details are in [README](README.md#development)
and [AGENTS](AGENTS.md#validation).

Provisional thresholds for this small pilot (not production SLAs):

- Privacy/access tests all pass; any leak or wrong-target mutation blocks entry/continuation.
- Required deterministic commands and restart/reminder checks all pass.
- Review at least 20 expected capture events: precision ≥80%, recall ≥70%; count duplicates
  as errors and keep the actual numerator/denominator. Match against stored records after the
  scenario drains, not only bot acknowledgements. Precision is correct unique captures / all
  captures; recall is expected events correctly captured / all expected events. Report actions
  and decisions separately as well as overall. Ambiguous cases are reported separately.
- At least 8/10 known-answer questions are judged correct and useful by a person; no invented
  writes or owners. LLM judging assists review and does not replace it.
- Measure typical and slowest reply times, model failures and unsolicited messages. Ask the team
  whether latency/noise is acceptable before inventing a performance or notification subsystem.
- At pilot end, the team identifies concrete saved effort and chooses continued use. Otherwise
  fix the most material problem or stop expanding scope.

### Candidate disposition — 2026-09-16

**Implemented and packaged; not yet pilot ready.** Runtime `2ba7a1f` is available locally as
`wire-team-bot:v3-rc-2ba7a1f`. This image is now active on the designated staging backend;
user-driven Wire smoke checks are underway. No production deployment was performed.
Human review and designated Wire acceptance still prevent closing P0–P2.
[Release evidence](tests/acceptance/release-evidence.json) records the image digest, configuration
and check boundaries without credentials.

- Fresh final build, `npx tsc --noEmit` and lint pass. **222 tests pass** in 38 files, including
  six isolated Postgres/pgvector integration tests. Native SDK loading passes in the release
  image (Node 22.23.2, glibc 2.41, linux x86_64); the older host glibc cannot load it.
- Full real-model e2e: **54/56**, with original assertions retained in
  [e2e-report.json](tests/acceptance/e2e-report.json). The full suite was rerun against immutable
  image `2ba7a1f`, retaining its compiled runtime and production dependencies; only the test
  harness/tooling was mounted read-only. This supersedes the earlier working-build run and
  reproduces the same two failures. The added same-conversation caller-switch regression passes;
  successful replies are also retained for inspection. Final-image capture/recall passes;
  earlier CLI restart evidence remains attributed below.
- Final-image stored-record evaluation at `2ba7a1f`: **20/20 correct unique captures out of
  20 expected and 20 total stored** (10/10 decisions, 10/10 actions), zero duplicates: automated
  precision/recall **100%/100%**, versus baseline 100%/50% (10/10/20). Half the expected events
  are passive; scoring queries all persisted records after drain and matches facts/source/owner.
  No marker in inspected DB records or diagnostics. See [candidate report](tests/acceptance/candidate-report.json)
  and [baseline report](tests/acceptance/baseline-report.json). This is a small synthetic sample,
  not human-approved extraction quality.
- Assistant inspection finds all ten known answers match the expected facts and the unknown
  budget question correctly reports no record. **Human correctness/usefulness review pending.**
  Median reply-event completion: **6.389 s**; known-question median **7.557 s**; slowest **9.392 s**;
  unsolicited messages **0**. Two malformed query-analysis responses fell back to the default
  retrieval plan; answer outputs remain in the report. Timings include queue drain.
- `TC-PIPE-06` expects an Alice-owned action from “we need to update the API documentation”.
  The conservative extractor writes none. Resolve this expectation explicitly against the
  no-guessed-owner rule; do not silently change either the assertion or ownership policy.
- `TC-ACT-07` is a judge false negative: the actual response says “end of month: 30 Sept 2026,
  23:59”, yet the judge rejects it against “end of month or March”. Final-image inspection
  confirms Carol owns the action with deadline `2026-09-30T23:59:59.000Z`; timezone/leap-year/DST
  unit tests pass. Human adjudication remains recorded as pending, not a green suite.
- Chat configuration: classify/judge `claude-haiku-4-5`; extract, summarise, query analysis,
  respond and complex synthesis `claude-opus-5`, with the same per-slot fallback models.
  Embeddings **off**, configured dimension 2560. DB vector behaviour was exercised with synthetic
  vectors; enabling real-provider embeddings requires its own smoke check.
- Earlier `bde0d0a` image CLI checks verify decisions, named actions with deadlines, PAUSED and SECURE
  across process restarts, resume and list retrieval. Persisted inspection finds one decision,
  one correctly owned/dated action, a closed secure range and no excluded marker. Earlier
  candidate smoke also exercised queued cancellation and model-backed recall. These are
  CLI/DB checks, not Wire transport evidence.
- Simulation replay completed all 57 source events with actual fixture senders: six decisions,
  seven actions and one reminder. Its stored-record inventory is local and unreviewed;
  `golden.json` remains an instruction placeholder. **No measured simulation precision/recall
  is claimed.**

Designated Wire test conversation: **Wire Team Bot Testing**,
`3c09c898-b840-4644-9bfc-1fc29d87b2cc@staging.zinfra.io`. The user supplied the name;
a read-only lookup in the running staging SDK conversation store resolved it uniquely.
Operator: **@adamhuman**, already signed in to the staging webapp. Second participant:
**@adamlow_wire**, reported by the user as already in this conversation. Both accounts belong
to the operator and can be used for assignment/attribution checks. This identifies the test
location and accounts; it is not a completed candidate smoke test. Human reviewer remains
to be identified.

Initial staging activation (2026-09-16 16:11 UTC): the `jeeves-staging` container used
`wire-team-bot:v3-rc-bde0d0a` with the tested digest and existing identity/volumes. Only the
designated conversation was present and no reminders were pending before the switch. Models
match the accepted synthetic configuration; embeddings are off. Startup hydrated one conversation
and reported the Wire client listening, with one content-free SDK error still unexplained.
The operator's screenshot confirms a mentioned `status` request received a channel-status reply
showing ACTIVE: initial receive/decrypt/reply and mention routing pass. At that check the container
had zero restarts; SDK error count had not increased from startup. This does
not yet verify reminders or a subsequent reconnect. The next operator screenshot confirms
`DEC-0002` creation and correct model-backed recall of Postgres and its transactions rationale.
Scoped database inspection confirms Adam (Human) attribution, empty context and one audit entry. The registered
app display name is still **AI Team Bot (adamlow, staging)**; changing it to **Wire Team Bot**
remains an operational naming check.

Rollback snapshots (private, outside Git): `/tmp/wire-v3-staging-backup-kcqACp/database.dump`
and `crypto-store.tar.gz`; both were checked readable. The candidate override is in that same
directory as `candidate.override.yml`. The old `jeeves:staging` image was retained. If rollback
is needed, use `docker compose -f docker-compose.staging.yml up -d --no-deps --no-build jeeves`;
retain the current database and crypto volume. Do not reset or restore identity storage for an
ordinary image rollback.

Assignment fix and staging update (2026-09-16 16:42 UTC): `82fe04b` preserves explicit
`@handles` and punctuated display names, and caches Wire profile handles during restart/join/
refresh. Four contract cases reproduced the prior failure; six new tests now pass. Fresh build,
type-check, lint and 213 tests pass. Full unchanged real-model suite on the immutable new image
remains 53/55 with the same two documented discrepancies. The isolated
[owner smoke report](tests/acceptance/owner-smoke-report.json) verifies the stored Bob owner and
Friday deadline, model recall, and no write for an unknown handle. Pipeline/model prompts did not
change in that fix; its quality evidence was measured at `bde0d0a`. The current sample above
was rerun on `2ba7a1f` after the caller prompt changed.

That update activated `wire-team-bot:v3-rc-82fe04b`, with the same database and crypto volume. Fresh
snapshots and its override are in `/tmp/wire-v3-owner-backup-QFDF2p/`; backup readability passed.
Startup hydrated one conversation and logged no SDK errors. The subsequent operator screenshot
confirms a post-restart round trip and correct persisted assignment for `ACT-0002`: owner
@adamlow_wire, creator @adamhuman, deadline `2026-09-18T12:00:00.000Z`, one audit entry.
The `my actions` reply incorrectly addressed the previous speaker; caller-specific acceptance
failed and requires the repair below. To roll back this update to the previous candidate:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-staging-backup-kcqACp/candidate.override.yml up -d --no-deps --no-build jeeves`.
Keep current volumes; no database or crypto reset is required.

Caller fix and staging update (2026-09-16 17:04 UTC): `2ba7a1f` routes a leading actual Wire
mention by qualified identity and its bounded UTF-16 span, independent of the registered display
name. Both model stages receive the current requester explicitly. Contract tests cover custom
labels, Unicode, qualified identity, invalid spans and privacy controls; the real-model caller
switch verifies Alice and Bob receive their own assignments in one conversation. Build/type-check/
lint and 222 tests pass; full image regression is 54/56 with the same two retained discrepancies.
The 20-event stored-record and 11-question evaluation was repeated on this image as reported above.

Staging now runs `wire-team-bot:v3-rc-2ba7a1f`; database and crypto volumes were preserved.
Fresh readable snapshots and override: `/tmp/wire-v3-caller-backup-tbxaea25/`. Startup connected,
hydrated the member cache and reported zero SDK errors and zero container restarts. The next
operator screenshot confirms both mentioned `my actions` and `What am I responsible for here?`
correctly return Adam Low’s two open actions, including `ACT-0002` with its September 18 deadline.
The Q&A identifies Adam Low as the current requester, with no incorrect Adam (Human) disclaimer.
Caller-specific list/Q&A and post-restart receive/decrypt/reply now pass on this image. This
does not yet verify reassignment, deadline changes, completion, reminders or privacy-state restart.
Rollback to the preceding image while keeping current volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-owner-backup-QFDF2p/candidate.override.yml up -d --no-deps --no-build jeeves`.

Remaining entry checks, in order:

1. A named reviewer reviews the fixed sample’s stored records/source events, all ten answers
   and unknown-answer output; record reviewed numerators and denominators here (thresholds above).
   Review simulation misses/false positives using `npm run simulate:review` as supporting evidence.
2. Adjudicate the two e2e cases above. Preserve the raw results; any changed behaviour needs a
   regression run. Review latency and unsolicited output with the team.
3. Use @adamhuman and @adamlow_wire for assignment checks in the designated conversation. Run the
   [Wire smoke steps](README.md#designated-wire-smoke-test) on the pinned image, including names,
   decryption, correction commands, reminder downtime/failed-send recovery and both privacy states.
4. Record the approved team/provider configuration and completed gates here, then begin the
   five-working-day P3 pilot. Do not reset a shared database or assume legacy raw rows are clean.

Known limits: transient queued work is lost at restart; reminder delivery is at least once;
source/exact-fact dedup does not guarantee semantic dedup; already-dispatched provider requests
cannot be recalled; retrieval is channel-scoped; historical data was not scrubbed. SDK diagnostics
retain severity but intentionally omit free-form message/payload detail. Human usefulness and
the remaining Wire journeys/reconnect checks remain unverified for this candidate.

### Progress and evidence log

Update this table with dated evidence as work completes. A blocked test stays pending with its
reason; an implementation or historical passing count alone does not close a release gate.

| Date | Item | Result / evidence | Next action |
|---|---|---|---|
| 2026-09-16 | Consolidation | Root plans reviewed against `f034d2f`; conflicting claims replaced, V3 scope triaged | Run P0 and fix P1 |
| 2026-09-16 | Development-goal review | Separated release-candidate acceptance from P3; identified simulation scoring limits and reminder send-failure gap by source review | Complete P0–P2; do not claim runtime verification from this review |
| 2026-09-16 | P0 baseline | Commit `e35428b`: 151 unit/contract tests passed in `node:22-trixie-slim`; host contract suites blocked by glibc 2.38 requirement. Isolated pgvector 16 database created on loopback port 55439; 11 migrations applied. Configured `claude-haiku-4-5` responded to a synthetic probe. | Measure stored facts with fixed source events; human quality review pending |
| 2026-09-16 | P1 implementation | Qualified retrieval/mutation checks, raw-context removal, cancelled channel queue work, both-buffer clearing, fail-closed hydration/resume, and content-free model error diagnostics implemented. Container unit/contract run: 166 passed; lint passed. | Complete isolated DB marker inspection and model/Wire journeys before closing gate |
| 2026-09-16 | P2 implementation | Reminder sends commit fired state after delivery, retry after 60 seconds and recover overdue pending rows; concurrent callbacks suppressed. Owner resolution, source-event replay guards, bounded model parsing, read-only Q&A instructions, current product name and text controls implemented. Configured Opus rejected temperature (HTTP 400); bounded compatibility retry added. | Full model regression, stored-record rerun and release image underway; Wire smoke and human review pending |
| 2026-09-16 | Stored-record evaluation | `cb1304e`: 20/20 expected facts captured (decisions 10/10, actions 10/10), 20 total captures, zero duplicates; ten answer outputs plus unknown-answer case retained for human review. This is automated fact/source matching, not a human quality approval. | Rerun after final completion/deadline fixes and obtain human review |
| 2026-09-16 | Model regression diagnosis | Initial full run 52/55. NDA completion was classified as low-signal; routing updates to extraction makes the isolated lifecycle reproduction pass. Explicit deadline text now reaches persistence. TC-PIPE-06 expects ownership inferred from “we need”; this conflicts with the plan’s conservative ownership rule and remains visible. | Full final regression; resolve ownership expectation before marking acceptance passed |
| 2026-09-16 | Deadline regression | `2be6486`: end-of-month dates now resolve in the conversation timezone (UTC, leap-year and DST tests); both owner/deadline command orders work. The model judge still rejected the literal correct “end of month: 30 Sept 2026” confirmation against a stale March-oriented assertion. Stored date and deterministic tests pass; the raw judge result is retained. | Human adjudication; do not weaken the assertion or change a correct date to March |
| 2026-09-16 | SDK diagnostic privacy | SDK free-form messages and nested payloads were found to bypass model-log sanitisation. Severity-only bridge and content-free top-level failure diagnostics now have a marker regression. Fresh container run: 205 tests passed, including six isolated DB tests; build/type-check/lint passed. | Rebuild final image; application event IDs remain available, SDK message detail is intentionally suppressed |
| 2026-09-16 | Final release image and quality | `bde0d0a` image built; native SDK load and CLI pause/secure restart smoke passed. Final-image fixed sample: 20/20/20, zero duplicates/markers, 10 answer outputs and unknown response inspected, human review pending. Full e2e remains 53/55 with the two cases above retained. | Human review, two adjudications and designated Wire smoke; no production deployment |
| 2026-09-16 | Capture scoring order regression | Reproduced a duplicate returned before its valid source being omitted from the duplicate counter (precision already penalised it). Source-first matching and order-independent duplicate grouping fixed; two regression tests added. Fresh build/type-check/lint and 207 unit/contract/isolated DB tests pass. Re-scoring both saved inventories preserves baseline 10/10/20 and candidate 20/20/20, zero duplicates. Runtime image unchanged. | Complete unchanged e2e suite against the immutable image; human/Wire gates remain pending |
| 2026-09-16 | Immutable-image full regression | Unchanged real-model suite run against `wire-team-bot:v3-rc-bde0d0a`: 53/55, same TC-PIPE-06 ownership expectation and TC-ACT-07 judge false negative. Runtime/dependencies were taken from the image; harness mounted read-only. Raw results and exact README command committed. | Human quality review, two adjudications and designated Wire smoke remain pending |
| 2026-09-16 | Staging candidate activation | User requested continuation after naming the test conversation/accounts. Database and stopped crypto store backed up; existing volumes retained. Pinned image started at 16:11 UTC; one conversation hydrated and client startup completed. One SDK error remains unexplained; operator status round trip requested. | Verify actual Wire receive/decrypt/reply before marking transport passed |
| 2026-09-16 | Initial Wire round trip | Operator screenshot confirms actual bot mention + `status` produced an ACTIVE channel-status reply on the pinned candidate. Container has zero restarts; no additional SDK errors beyond startup. Screenshot shows registered name AI Team Bot (adamlow, staging). No surrounding channel text copied into evidence. | Test decision capture/recall next; rename registered app and finish remaining Wire journeys |
| 2026-09-16 | Wire decision capture/recall | Operator screenshot confirms DEC-0002 and correct Postgres/transactions answer with author attribution. Scoped DB inspection confirms active record, empty context and one audit entry. | Continue assignment and reminder smoke checks |
| 2026-09-16 | Real-member assignment parser gap | Before testing the supplied handle, four mocked contract cases reproduced dropped @handle/parenthesised-name assignees and missing handle hydration. Explicit target parsing now preserves these references and member profiles retain handles across restart/join/refresh; qualified resolution rejects unknown or ambiguous targets. | Validate, rebuild image and resume Wire assignment check |
| 2026-09-16 | Assignment fix validated and staged | `82fe04b`: 213 tests, build/type-check/lint pass; real-model owner smoke verifies persisted Bob attribution and unknown-owner refusal. Immutable-image full regression 53/55, same two retained failures. Staging updated with fresh backups and existing volumes; startup has zero SDK errors. | Operator handle assignment and post-restart Wire check |
| 2026-09-16 | Wire handle assignment and caller confusion | Operator screenshot confirms ACT-0002 was assigned to @adamlow_wire with Friday deadline; scoped DB confirms qualified Adam Low owner, Adam (Human) creator and one audit entry. Mentioned `my actions` incorrectly went through Q&A and addressed the prior speaker as you. Reproduced custom-display-name mention parsing failure in contract tests; repair uses bounded UTF-16 mention spans and explicitly passes the current caller to query analysis/answering. | Validate and stage the repair, then repeat caller-specific list and privacy controls on Wire |
| 2026-09-16 | Caller fix validated and staged | `2ba7a1f`: 222 tests and build/type-check/lint pass; immutable-image real-model regression 54/56, same two discrepancies; caller-switch answers inspected. Fresh stored-record evaluation 20/20/20, zero duplicates/markers, human review pending. Staging updated with readable backups and preserved volumes; connected without SDK errors. | Repeat caller-specific list and Q&A as @adamlow_wire, then continue remaining Wire journeys |
| 2026-09-16 | Wire caller repair confirmed | Operator screenshot on `2ba7a1f`: mentioned `my actions` and first-person responsibility Q&A both return Adam Low’s two open actions and correct ACT-0002 deadline. No prior-speaker confusion; post-restart round trip passes. Evidence is the live screenshot, not a fresh automated run. | Test ACT-0002 reassignment, deadline change and completion; remaining Wire and human acceptance stays pending |
| — | P3 pilot decision | Not started | Record usefulness, noise, latency and up to three next fixes |

The former v1/v2 plans, SDK migration plan and V3 gap list are superseded by this document.
Their historical text remains in Git. SDK operational cutover steps are retained in README;
there is no second active roadmap.
