# Jeeves — App and Delivery Plan

Updated: 2026-09-16. Source review: `f034d2f`.

This is the single source of truth for the app, feature scope, architecture and delivery
progress. The next version is a **real-world pilot of the existing bot**, with targeted
reliability fixes. It is not a rewrite or a commitment to every former V3 proposal.

[README.md](README.md) covers setup and operation. [AGENTS.md](AGENTS.md) covers contributor
rules. Update progress here; do not create another versioned plan or gap backlog.

## 1. What we are building

Jeeves is a Wire participant that helps a team remember decisions, keep track of commitments,
and catch up on work without maintaining a separate record by hand.

| Team need | Useful outcome | Pilot boundary |
|---|---|---|
| Capture | Record a decision, action, owner or reminder from the conversation. | Explicit commands plus the existing passive extractor; tolerate conservative capture. |
| Recall | Answer what was decided, why, by whom and when, using the team's record. | Current channel only; say when the available record cannot answer. |
| Progress | See open/overdue work, mark it done, change an owner or deadline, receive reminders. | Existing action lists, updates, nudges and summaries; no new project-management system. |
| Control | Know when Jeeves is listening and stop processing sensitive discussion. | ACTIVE / PAUSED / SECURE, with verified context isolation. |

The pilot should answer: **does this save the team work, with sufficiently few mistakes and
interruptions that they choose to keep using it?** A large feature count is not a success measure.

Product rules:

- Keep the common tasks easy to express. Add natural-language variants when observed usage
  fails; a new intent framework is not a prerequisite for testing.
- Confirm actual writes, owners and deadlines. Do not imply an action happened when it did not.
  Ask a short clarifying question when a consequential choice is ambiguous.
- Keep `DEC-`, `ACT-` and `REM-` references for reliable corrections during the pilot. Removing
  them requires a proven replacement, not a blanket presentation change.
- In groups, teach users to mention Jeeves for questions and use the documented commands for
  changes. Existing unmentioned follow-ups are a heuristic, not a general conversation contract.
- Keep passive capture quiet. Fix misleading prompts and dead controls before adding new ones.
- Retain the existing Jeeves voice: concise, no exclamation marks, “I'm afraid” rather than
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

- ACTIVE messages pass through classification, extraction and asynchronous embedding.
  `InMemoryProcessingQueue` allows five concurrent jobs and 500 queued jobs; overflow drops
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
- Jeeves sees decrypted messages as a Wire participant. Model requests go to the configured
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
model, fallback and database dimensions. The old promised startup dimension check is not
implemented in the current adapter. Vector features need a separate smoke test if enabled;
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
| Passive capture and natural completion | Implemented with prompt-based duplicate mitigations | Human-reviewed precision/recall and duplicate baseline absent |
| Questions and channel summaries | Implemented; retrieval and summary tests present | Validate known-answer questions, empty results and provider degradation |
| Action lists, staleness nudges, scheduled summaries | Implemented | Judge usefulness/noise; verify restart and overdue behaviour |
| Pause, resume, secure and access scoping | Partial; controls exist, concrete gaps below | P1 is a pilot blocker |
| Embeddings optional/separate provider | Implemented; embedding configuration tests present | Smoke test selected configuration and dimensions |
| Buttons and contradiction follow-through | Partial; confirmation transport exists, router has no useful button dispatch | Remove dead offers or make existing interactions actionable (P2) |
| Test harness and simulation | Implemented | `golden.json` contains only instructions; quality is unmeasured (P0) |
| Configurable bot name | Earlier gap doc referenced unmerged PR #8; absent from reviewed config | Not required for pilot; verify separately before claiming delivered |
| Documentation consolidation | Complete in this revision | Maintain this plan as work lands |

Historical validation: SDK migration notes reported 141 passing unit tests, clean lint, an
offline CLI smoke run, and then staging connectivity/restart success. Those notes also contain
an older “not exercised yet” entry, superseded by their staging update. No fresh runtime test
or LLM-quality result is claimed by this documentation review.

### Concrete gaps found during consolidation

These are source observations, not a full security audit or an end-to-end reproduction.

| Gap | Evidence | Required outcome |
|---|---|---|
| Raw conversation fragments can persist | `ProcessingPipeline.process` stores `text.slice(0, 200)` for low-signal messages. `LogDecision` copies `contextMessages[].text` into persisted decision context. | Remove unintended raw-context storage; inspect existing test data and other persistence/log paths. |
| SECURE does not isolate all context | Router pushes into the Q&A buffer before checking state; SECURE flushes the sliding window only. Pipeline jobs do not re-check channel state before classification. | Isolate both buffers and work crossing a state transition; test resume and restart. |
| Explicit-ID lookup can bypass retrieval scope | `StructuredRetrievalPath` calls `findById` and labels results with the requesting channel without checking the record's channel. Some mutation checks compare ID without domain. | Enforce full qualified scope for returned records and mutations; add negative tests. |
| Replies can promise unsupported interaction | `LogDecision` offers buttons; `onButtonClicked` only handles the default/unhandled case. Contradiction notices ask a question without a dedicated resolution flow. | Use supported text instructions or remove the offer; do not require a new undo/button subsystem. |
| Model failures and metrics are only partly handled | Adapters already parse/filter output and provide fallbacks, but extraction errors log output previews; metrics module is a no-op. | Verify malformed output cannot cause bad writes or content logging; measure only what pilot decisions need. |
| Reminder delivery can be lost after a send failure | `FireReminder` marks a reminder fired before sending, then catches send errors. Startup only rehydrates pending reminders. | Test failed sends and recovery; make failed delivery recoverable without claiming exactly-once transport. |
| Simulation output is not a reliable capture inventory | `simulate.ts` scans reply IDs, segments output using fixed delays, and compares golden entries by generated ID. Silent writes and fresh-run IDs can invalidate its scores. | Inspect records in an isolated scenario channel after processing finishes; match expected facts/source events rather than generated IDs. A small manual baseline is sufficient initially. |

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
| P0 | Establish baseline using existing fixtures, isolated DB inspection and the intended model configuration. | Stable expected facts including missed/silent captures; reviewed precision/recall, duplicate count, ten known-answer questions, response times and failures. Record commit, configuration and date; do not rely on printed IDs alone. | Pending |
| P1 | Close the concrete data-retention, state-isolation and access-scope gaps in §3. | DB/log inspection with synthetic marker text; pause/secure/resume tests for both buffers and queued work; cross-channel and cross-domain retrieval/mutation denial tests. Review audit coverage on affected writes. | Pending — blocks real data |
| P2 | Make existing user journeys dependable. Verify names after restart, reminder downtime/send-failure recovery, corrections, model failures, and text alternatives to dead controls. | Required journeys in §5 pass on CLI and Wire. Fix duplicate or malformed-output failures locally when reproduced. No unsupported “Shall I…?” or inert required button. | Pending |
| P3 | Run one small team pilot and decide the next investment. | Five working days of use, short feedback log, counts against §5 and a keep/fix/stop decision. At most three evidence-backed follow-ups. | Pending |

Small fixes may touch validation, deduplication, prompts or command variants. They do not imply
a general intent executor, a new schema library, vector dedup across every write, or scheduler
replacement. If the existing baseline is adequate, proceed to the pilot without feature work.

### Development goal and finish line

**Build Jeeves v3 as a tested release candidate for the small team pilot: close P1, complete
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

### Progress and evidence log

Update this table with dated evidence as work completes. A blocked test stays pending with its
reason; an implementation or historical passing count alone does not close a release gate.

| Date | Item | Result / evidence | Next action |
|---|---|---|---|
| 2026-09-16 | Consolidation | Root plans reviewed against `f034d2f`; conflicting claims replaced, V3 scope triaged | Run P0 and fix P1 |
| 2026-09-16 | Development-goal review | Separated release-candidate acceptance from P3; identified simulation scoring limits and reminder send-failure gap by source review | Complete P0–P2; do not claim runtime verification from this review |
| — | P0 baseline | Pending; golden file is an instruction placeholder | Record sample, configuration, counts and reviewed failures |
| — | P1 privacy/access | Pending; source gaps listed in §3 | Implement targeted fixes and negative tests |
| — | P2 core journeys | Pending; SDK staging success is historical only | Record current CLI/e2e and Wire results |
| — | P3 pilot decision | Not started | Record usefulness, noise, latency and up to three next fixes |

The former v1/v2 plans, SDK migration plan and V3 gap list are superseded by this document.
Their historical text remains in Git. SDK operational cutover steps are retained in README;
there is no second active roadmap.
