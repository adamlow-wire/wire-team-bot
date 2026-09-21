# Wire Team Bot — App and Delivery Plan

Updated: 2026-09-21. Staging runtime/image: `8c0c89d` (case fix `8e2cce8`, baseline `e35428b`). Latest tested QA runtime: `8c0c89d`.

This is the single source of truth for the app, feature scope, architecture and delivery
progress. The app is a **proof of concept demonstrating the Wire JS SDK**. The next milestone is
QA acceptance of the existing bot, followed by a small real-world pilot with targeted
reliability fixes. Adam set **1.0.0** as the release target on 2026-09-21. Keep that target within
this proof-of-concept scope; it is not a rewrite or a commitment to every former V3 proposal.

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
- Keep passive action capture quiet but visible: 📝 on the source message after an action and its
  audit are saved; ✅ on an unmentioned completion after the status and audit are saved. A reaction
  means at least one matching change succeeded; lists show details. No success reaction for skipped,
  duplicate, failed or cancelled work. Reaction delivery failure must not undo or repeat a saved write.
  Explain the meanings in the welcome message. Explicit commands retain their text confirmations.
- Use native Wire replies for direct responses so each confirmation or answer identifies its source.
  Keep only the SDK quote ID/hash during the handler; never persist source text for quoting.
  Scheduled notifications remain standalone. Wire disallows quoting self-deleting messages.
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
| P2 | Make existing user journeys dependable. Verify names after restart, reminder downtime/send-failure recovery, corrections, model failures, and text alternatives to dead controls. | Required journeys in §5 pass on CLI and Wire. Fix duplicate or malformed-output failures locally when reproduced. No unsupported “Shall I…?” or inert required button. | Reactions/native replies Wire-confirmed; attribution, combined-command guidance and Friday date fixes implemented. Latest step-two validation is recorded below; final candidate Wire/human acceptance pending |
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

### Automated QA before final manual acceptance

Agreed direction (2026-09-18): freeze feature scope and finish automated QA before asking Adam
for one final manual acceptance session. The SDK proof of concept is the product framing;
this is not a production release. Existing manual screenshots remain evidence, but repeated
operator demos must not substitute for automated reproduction and stored-record inspection.

| Step | Work the developer runs autonomously | Completion evidence |
|---|---|---|
| QA-0 | Reconcile README with the actual SDK/configuration, keep only `main` active, explain archived work, and normalize repository commit attribution as requested. | README has the PoC statement and no former product-name references; repository inventory and history verification below. |
| QA-1 | Fix recorder-versus-decider attribution in retrieval/answers. Identify the recorder as such; report an actual decider only when the stored fact supports it. Reproduce TC-DEC-07 with Alice recording Carol/Dave's decision. | Mocked regression plus real-model answer and stored-source checks; no contradictory attribution even if the model judge says PASS. |
| QA-2 | Give deterministic, truthful guidance for multiple commands in one message. Keep one command per message for this PoC; do not invent a batch executor. | Two reminder requests receive a split-message explanation and create no partial/accidental records; separate messages each create one reminder. Include structured mentions and formatted commands. |
| QA-3 | Separate application failures from evaluator errors. Use explicit ownership for the positive dedup test and retain ambiguous ownerless wording as a negative case. Ground date checks in scenario time/timezone and actual persisted deadlines; check recorder identity against stored authors. | Preserve the original 57/60 report and explain each expectation change. Add positive and negative coverage rather than relaxing assertions; a judge PASS cannot override wrong stored facts. Dates and identities have deterministic assertions as well as answer review. |
| QA-4 | Run build, type-check, lint, unit/contract and isolated Postgres/pgvector tests. Exercise paused/secure buffers, queued/in-flight cancellation, process restart, scoped ID reads/writes, failed sends, overdue recovery, malformed outputs and timeouts. | All deterministic checks pass. Unique excluded markers absent from stored records/diagnostics and captured mock model requests. No shared DB resets; test data stays in isolated conversations/databases. |
| QA-5 | Run the full real-model e2e suite, the fixed 20-event/10-question sample, reaction lifecycle and simulation after extraction/pipeline changes. Inspect all stored records after drain, including silent captures. | Versioned inputs/outputs, fact/source/owner matches, precision and recall with counts, duplicates, latency, failures and unsolicited messages. Human quality approval remains pending; no unexplained runtime failures or hidden judge overrides. |
| QA-6 | Build one immutable candidate from the tested commit and run the full suite against that image. Back up staging DB/crypto state, activate that exact image, verify hydration/decryption readiness and collect a concise QA packet. | Image digest, configuration without secrets, test results, rollback steps and exact manual cases in this plan. Do not silently replace the candidate during manual QA. |
| QA-7 | Adam performs final Wire UI and usefulness acceptance using the prepared candidate. The developer handles coordinated restarts and post-process DB/audit inspection during the same session. | All manual cases below accepted; any defect returns to its automated reproduction/fix/regression step before a focused retest. |

Use the existing [README validation commands](README.md#release-candidate-acceptance), fixtures,
CLI and test runner; add bounded assertions or a small orchestration script only where an
existing gate is not reproducible. No new framework, model-provider migration, queue service
or feature subsystem. A provider outage is a recorded blocked check, never a silent pass.
Autonomous work stops at a concrete candidate and QA packet ready for Adam; it does not claim
manual acceptance, reset shared data or deploy to production.

Final manual QA packet, prepared after QA-1 through QA-6:

1. **Wire presentation:** real mentions, two quick requests with correct native reply targets,
   passive capture/completion reactions, member names and registered app branding.
2. **Core journeys:** decision correction/recall with correct recorder and decider, action
   assignment/reassignment/deadline/completion, reminder creation/cancel/snooze/downtime recovery.
3. **Privacy/access:** PAUSED and SECURE with unique markers before/after a coordinated restart,
   then scoped read/mutation denials from the second designated test channel. Developer verifies
   records/audits after processing; absence of a visible reply is not enough.
4. **Quality/usefulness:** approve at least 20 expected captures and ten known answers, plus an
   unknown-answer refusal and catch-up/open/overdue summaries. Apply §5 thresholds without
   inventing writes/owners; judge latency and noise from the supplied measurements.

Only after this single final acceptance stage passes does the five-day P3 pilot begin.
September 18 checkpoint (superseded by the September 21 case fix below): QA-0 through QA-3 are implemented. Adam authorised the second implementation
step on 2026-09-18. The final `ae618ff` image passes **63/63 strengthened real-model scenarios**,
all fifteen mandatory stored-record/state checks, and the unchanged **20/20 stored-fact sample**.
Build/type-check/lint and **370 unit/contract/isolated DB tests** pass. All earlier failed runs and
raw-review findings remain intact. QA-6 activation is complete: staging now runs that exact image,
with verified backups, unchanged durable records, member/reminder hydration and no startup errors.
Final Wire/human acceptance remains pending. The first candidate `status` smoke reply had the correct
native quote but took approximately 25 seconds. On September 21 Adam reported speed and reply
targeting accepted; numeric timings and a confirmed cause of the earlier reconnects remain unavailable.
This is code and automated QA completion, not pilot approval.

#### Case-insensitive record references — 2026-09-21

Adam reports manual tests 1–3 passed on `ae618ff`: reply speed/quote targets, post-revocation
recall and action ownership/deadline/completion. No numeric reply timings were supplied; this
is operator acceptance, not a measured transport latency benchmark or confirmed root-cause fix.
Scoped DB inspection of `ACT-0008` in Demo for Anna confirms done/version 4, owner Adam (Human),
deadline **2026-10-02 12:00 UTC**, original source ID and four audits: created for Adam Low,
reassigned to Adam (Human), deadline changed, completed. The visible lowercase `act-0008 done`
attempt failed; the uppercase retry succeeded. This additional usability defect is fixed in the replacement candidate, with Wire confirmation passed by Adam on September 21.

Root cause: command regexes already ignore case but passed lowercase captures unchanged to
case-sensitive repository lookups. Normalize only matched ID tokens before mutations and direct
structured retrieval. Accept lower/mixed-case ACT/DEC/REM prefixes; preserve the hyphen, digits,
leading zeroes, surrounding text, qualified scope and canonical uppercase replies. No storage
migration, changed IDs or new dependency. Malformed IDs remain malformed. The existing e2e
capture mechanism now exposes lowercase aliases for test inputs; output and stored-fact
assertions retain canonical IDs and original source events. Decision supersession/revocation
also gained mandatory post-exit stored-state checks; no assertions were relaxed.

Red baseline: **10 new lowercase command cases fail**, 119 router cases pass. After the fix:
build, `tsc --noEmit`, lint and **387 tests in 43 files** pass, including six isolated DB tests,
case-insensitive direct retrieval and qualified-scope denials. Validation uses Node 22/trixie
and the isolated pgvector database on port 55439. Fresh evaluator calibration is **12/12**;
full real-model regression is **63/63**, with **17 mandatory post-exit stored/state checks**.
An additional exact post-exit reminder inventory check confirms one correctly owned cancelled
reminder, its source fact and the snoozed deadline. Raw inputs, replies and inventories for
lowercase mutations and retrieval were reviewed; canonical replies and qualified scope remain intact.
See [validation](tests/acceptance/lowercase-id-validation.json),
[full results](tests/acceptance/lowercase-id-e2e-report.json),
[calibration](tests/acceptance/lowercase-id-calibration.json) and
[manual 1–3 evidence](tests/acceptance/manual-qa-steps-1-3.json).

At **10:07:02 UTC**, staging was updated to `wire-team-bot:v3-rc-8c0c89d`, image
`sha256:194eac6f1efb420b50ca5c54c6e6a816b83743c713868ccd0c91464310a79d93`.
[Activation evidence](tests/acceptance/lowercase-id-staging-activation.json) records verified
Postgres/crypto backups, identical environment and volumes, and unchanged fingerprints for all
12 durable tables. Prisma files match the previous candidate; no migration changes. Startup
hydrated three conversations and connected successfully, with zero errors and one expected
embeddings-disabled warning. These are startup observations, not a sustained latency benchmark.
Backups and image overrides are private under
`/home/sysop/wire/wire-team-bot-backups/case-ids-rn6r9wgz`.
To roll back only the bot, retaining current DB/crypto state:

```bash
docker compose -f docker-compose.staging.yml \
  -f /home/sysop/wire/wire-team-bot-backups/case-ids-rn6r9wgz/rollback.override.yml \
  up -d --no-deps --no-build --pull never jeeves
```

**Wire follow-up — September 21:** Adam confirms the lowercase-ID retest worked on the
replacement candidate. This is operator confirmation; no new record ID or screenshot was
supplied and no additional DB inspection is claimed. Cases 1–3 retain their earlier pass.
**Case 4 follow-up — September 21:** Adam reports passive capture/completion passed in Wire.
Post-process verification of the exact source record, duplicate count and creation/completion
audits remains pending; no additional DB inspection is claimed from that report alone.
**Next:** cases 5–8, the remaining stored-record checks and human quality review.
Classifier/extractor/pipeline code is unchanged; no simulation rerun is required for this fix.
Container install/prune steps disable automatic npm audit uploads; the separately requested
audit remains unapproved and its existing findings remain recorded. No dependencies changed.

#### Work toward 1.0.0 — 2026-09-21

Adam authorised proceeding toward 1.0. Preserve the current feature scope and finish the existing
acceptance sequence: pinned candidate → final Wire/human acceptance → five-working-day pilot →
release decision against §5. Treat 1.0 as the version of this Wire JS SDK proof of concept, not
a production-readiness claim. Package and lockfile versions remain `0.1.0` during acceptance;
no 1.0 release tag has been created. Once accepted, update both version
fields together, build the final immutable image, validate the packaged artifact with the existing
checks and relevant journeys, and record its commit/digest, known limits and rollback instructions.
Any functional/dependency fix returns through its focused reproduction and required regression
checks before replacing the pinned candidate. Do not restart the whole implementation backlog.

Work completed while the operator runs the next manual checks:

- [Monday command/storage check](tests/acceptance/monday-command-storage-qa.json): existing
  `ae618ff` CLI in the pinned container, isolated Postgres/pgvector, fixed parser clock
  `2026-09-21T08:00:00Z`, UTC and Europe/London. **Six expected/six stored actions**, matched after
  CLI exit by source and fact, with exact qualified creator/owner, deadline, status and version.
  Sixteen command/list exchanges pass, including reassignment, deadline mutation, completion and
  removal from the owner's open list. **Twelve audits, zero extra decisions/reminders**. “This
  Friday” is **25 September**, “next Friday” is **2 October**, at local noon for date-only weekdays.
  Slowest synthetic command was **146 ms**; this excludes Wire transport and model calls.
- The first attempt failed before a reply because the isolated QA DB was stopped. Started that
  existing test container without resetting data, then reran the full focused check successfully.
  Staging was neither redeployed nor restarted. No new application code or dependencies.
- Through **07:45:43 UTC**, staging showed **zero SDK warnings and zero errors** since its
  **07:37:04 UTC** start (about 8 minutes 38 seconds). This is an observation, not proof of a
  permanent transport fix. Three timed, separated Wire `status` replies and the final revoked-
  decision recall answer have been requested from Adam, along with the actual conversation name.
- The known dependency issue was rechecked against its
  [public advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx): patched in `deepmerge-ts`
  **8.0.0**; the installed Prisma config dependency pins **7.1.5**. Local inspection still places
  it in the local config loader. No direct chat/model-input path was found. Do not treat a forced
  major transitive override as a verified compatible fix. The prior audit remains the only full
  recorded audit: automatic approval review rejected a fresh `npm audit --omit=dev --json` because
  it sends dependency names/versions to the npm registry. Adam has been asked whether to allow
  that transfer; no upload was attempted through another route and no audit pass is claimed.

Adam subsequently reported cases 1–3 passed; see the case-insensitive record entry above.
For a September 21 run, expect `this Friday` = September 25 and `next Friday` = October 2.
Next is a focused lowercase-ID retest, then cases 4–8 and human quality review. Friday's full test/e2e results remain their original runs; this new focused CLI check
does not replace them or the required real Wire acceptance.

#### Monday status check — 2026-09-21

Read-only checks at **07:38 UTC** confirm staging still runs the exact `ae618ff` image
(`sha256:4faa5df2a11d540e20659d89cb439755715060cb859f6db264a2c038bdb5abd0`).
The container reports a start at **07:37:04 UTC**, zero restarts, and no temporary Node options
or protocol probe mount. This status check did not restart or deploy anything. From that
start through **07:38:50 UTC** (about 106 seconds), there were **zero SDK warnings and zero
logged errors**. Friday's repeated reconnects were not observed in this short window;
this does **not** establish their cause, a durable fix, or acceptable user-visible latency.
Repeat timed real Wire `status` requests before closing that gate.

The previously pending synthetic `REM-0008`, scoped to Demo for Anna, is now **fired/version 2**.
Its original due time remains **06:00 UTC**; it was updated at **07:37:08.153 UTC**, shortly after
the reported container start, with one matching firing audit at **07:37:08.159 UTC**. This is
new durable evidence of overdue recovery; it is not on-time delivery or operator UI receipt
confirmation. The reason for the container's start time was not investigated in this status check.

Friday's **370 tests, 63/63 e2e cases, fifteen stored-state checks and 20/20 synthetic fact sample**
remain the latest automated results; no suite was rerun on Monday. Decision QA remains at the
recorded checkpoint below: correct attribution and audited supersession/revocation, with the
post-revocation Wire answer outstanding. Remaining final manual cases and human quality review
still gate the five-day pilot. The remote has only `main`, matching local `fae80ad` at inspection;
reachable commit authors/committers are Adam Low only. The working tree was clean before this
status-note update. The next focused step is timed `status` plus the outstanding decision question,
then assignment/deadlines, passive feedback, reminders, privacy/scope and usefulness checks.

#### Staging candidate activation — 2026-09-18

Adam authorised the staging upgrade. [Activation evidence](tests/acceptance/staging-qa6-activation.json)
records the exact image ID, backup checks and startup observations. Only the staging bot was
recreated; production and the staging database container were untouched.

- Activated `wire-team-bot:v3-rc-ae618ff` (the locally tested image), ID
  `sha256:4faa5df2a11d540e20659d89cb439755715060cb859f6db264a2c038bdb5abd0`.
  Previous image `wire-team-bot:v3-rc-4bc7e1f` remains available for rollback.
- Effective environment, credentials, Prisma schema and migration files match the previous
  service. Existing `jeeves-staging_jeeves-staging-crypto` and database volumes were retained.
  No tokens/keys were refreshed and no database was reset or restored.
- Old bot stopped cleanly at **16:19:38 UTC**. Private backups are in
  `/home/sysop/wire/wire-team-bot-backups/qa6-20260918-v3m1uubm/`, outside Git, with protected
  configuration, database archive and crypto archive. The entire database archive was decoded
  successfully without executing a restore; the crypto archive was extracted privately and its
  SQLite database passed `PRAGMA quick_check`. Verification copies were removed.
- New container started at **16:20:45 UTC** and reported connection/listening readiness at
  **16:20:47 UTC**. No pending migrations. Member cache hydrated **three conversations** and
  **one pending reminder**. Zero startup errors and zero restarts. Content-free SDK warnings
  remain visible; they do not establish a failed or successful client round trip.
- All **twelve table fingerprints are unchanged**: 4 decisions, 6 actions, 8 reminders,
  67 audit entries and 3 channel configurations among them. `REM-0008` remains pending,
  version 1, due **2026-09-21 06:00 UTC**, and was rehydrated. This verifies preservation and
  hydration; delivery after this restart has not yet occurred.
- Adam confirmed a real mentioned `status` request with the correct native quote on this
  candidate. Receive/decrypt/reply works, but his approximately **25-second delay fails latency
  acceptance**; see the investigation below. Earlier 370 tests/63 e2e cases remain their
  recorded runs; no runtime suite was rerun for this operational activation.

To reapply the candidate without rebuilding or changing volumes:

```bash
docker compose -f docker-compose.staging.yml \
  -f /home/sysop/wire/wire-team-bot-backups/qa6-20260918-v3m1uubm/candidate.override.yml \
  up -d --no-deps --no-build --pull never jeeves
```

Rollback the image while retaining current data and crypto state:

```bash
docker compose -f docker-compose.staging.yml \
  -f /home/sysop/wire/wire-team-bot-backups/qa6-20260918-v3m1uubm/rollback.override.yml \
  up -d --no-deps --no-build --pull never jeeves
```

Do not restore the pre-upgrade crypto snapshot for an ordinary image rollback: the live store
may have advanced. Database restoration is unnecessary because schema and migrations did not
change. The protected backup is a recovery resource, not an instruction to overwrite live data.
Keep this image pinned throughout manual QA; avoid a rebuilding `staging:up` during acceptance.

#### Staging latency investigation — 2026-09-18

**Unresolved release gate:** Adam's first `status` reply took approximately 25 seconds.
[Content-free evidence](tests/acceptance/staging-latency-investigation.json) records the
experiments, UTC timestamps and restoration checks. This command does not invoke a model.
The channel-state log at **16:58:10.168 UTC** was followed by outbound send at **16:58:10.174**
(6 ms for that section of the handler, not a measured end-to-end round trip).

The SDK reconnects roughly every **31.15 seconds**; replies were processed during reconnect
catch-up. Temporary protocol diagnostics confirmed a socket opens, receives a server ping at
15 seconds and closes remotely with code **1000** at 30 seconds. The SDK's existing `ws`
fallback behaved the same as Node's native WebSocket. Application pings every ten seconds
also failed to keep it open: automatic control pongs were sent, but no application pong was
received. Neither experiment is a fix. Both implementations passed a synthetic local
ping/binary-frame control in the exact candidate image.

The backend connection path needs investigation. In the inspected Wire server source, Cannon
registers presence with Gundeck before starting its receive loop, so a stuck registration is
one hypothesis consistent with these observations; **it is not an established root cause**.
Ask a staging backend operator to inspect **Cannon/Gundeck/nginz logs for 17:06–17:09 UTC on
2026-09-18**, correlate `/await`, `register-remote`/`registered`, `/i/presences` timeouts,
`PongTimeout` and close reasons, and identify the deployed backend revision. Never include
`access_token` query values in the handoff. Backend log access is not available in this
workspace; the operator has been asked for access/help. SDK/client compatibility remains an
alternative until the backend trace is available.

At **17:09:20 UTC** the original `ae618ff` image/configuration was restored; temporary Node
options and probe mount are absent. No runtime code/dependencies changed. Current database
counts remain **4 decisions, 6 actions, 8 reminders, 67 audits, 3 channel configurations**;
existing volumes were retained. Fresh private DB/crypto backups and diagnostic events are in
`/home/sysop/wire/wire-team-bot-backups/latency-05q9np8o/`. No database was reset or restored.
The reconnect cycle still occurs after restoration. No runtime regression suite was rerun
for these temporary diagnostic operations and documentation-only changes.

Adam requested continuing functional QA while the connection issue remains open. Proceed with
the manual cases below, recording delivery delay separately and waiting for each confirmation
before dependent commands. After correction, observe sustained connectivity and time several
mentioned `status` requests at different offsets in the former 30-second cycle. Correct content
and a native quote alone do not pass the latency gate or approve the pilot.

#### Final manual QA on the pinned staging candidate

Use **Demo for Anna** (`8791c80e-8209-4509-9c33-360e83b44c62@staging.zinfra.io`) as the primary
and **Wire Team Bot Testing** (`3c09c898-b840-4644-9bfc-1fc29d87b2cc@staging.zinfra.io`) for
scope-denial checks. Both were previously designated by Adam. Use actual Wire mentions of the
bot and people, selected in the client; the text below a mention is the command. Use the IDs
returned by this run in place of `DEC-A`, `DEC-B`, `ACT-A` and `REM-A`. Send one command per
message except the deliberately combined-command test. Case 1 has a correct quoted `status`
reply; Adam subsequently reports tests 1–3 passed, including reply targeting, final decision
recall and the action lifecycle (see the September 21 entry above). Lowercase ID input exposed
one additional defect fixed in the replacement candidate; Adam confirms the focused Wire retest passed on September 21. Case 4 is operator-confirmed passed, with its stored-record/audit verification pending.
Cases 5–8 remain **pending on the final candidate**.
The developer verifies persisted sources, qualified owners, status, deadlines and audits after
processing; the user checks Wire rendering and usefulness. Do not paste credentials or real
team transcripts into review artifacts.

**Case 2 evidence — 2026-09-18 18:35 UTC:** Adam supplied the quoted Wire replies through
revocation. [Scoped stored-record and audit checks](tests/acceptance/staging-decision-qa.json)
found exactly two matching synthetic facts: `DEC-0005` is superseded/version 2 and points to
`DEC-0006`; `DEC-0006` is revoked/version 2 and supersedes `DEC-0005`. There are exactly four
matching audit entries (two creations, supersession, revocation), with the qualified recorder
and actor matching Adam (Human), and distinct original message IDs. Neither record is active.
The explicit-command path stores the named maker and rationale in the summary; both `decidedBy`
arrays remain empty. The observed answer correctly uses that stored wording to identify Adam
Low as maker rather than treating the recorder as maker. No runtime changes or fresh automated
suite are claimed. These records are in `462a6490-fc3e-4c76-9f20-154c6b661336@staging.zinfra.io`,
not either previously designated room; the operator has been asked to confirm its display name.
Verification was limited to the reported synthetic facts and their audits. On September 21 Adam reported the final post-revocation question passed as part of cases 1–3.
That is operator confirmation; no new verbatim answer or numeric timing was supplied.

**Case 5 progress — September 21, 11:02 UTC:** screenshots confirm the expected combined-command
refusal, separate creation, cancellation and snoozed delivery. [Scoped stored evidence](tests/acceptance/manual-reminder-cancel-snooze.json)
finds exactly two matching facts with separate source IDs: `REM-0009` cancelled/version 2,
`REM-0010` fired/version 3, both owned by Adam (Human). The latter was snoozed at 10:59:09 UTC
until 11:01:09 UTC, then marked fired at 11:01:09.925 with one firing audit. This matches
12:01 UK summer time in the client. Cancelled non-delivery through its original 11:18 UTC
(12:18 UK) deadline and coordinated overdue recovery remain pending. Combined-event source ID
was not supplied; the inventory check finds no extra matching reminder fact.

**Case 5 recovery — September 21:** [Coordinated recovery evidence](tests/acceptance/manual-reminder-recovery-0921.json)
records `REM-0011`, due 11:07:41.733 UTC. Staging stopped at 11:06:28 UTC; a read at
11:07:46 UTC confirmed the overdue record remained pending/version 1 with only its creation
audit. The same container/image/crypto volume restarted at 11:07:47 UTC. At 11:07:49 UTC the
record became fired/version 2, with one firing audit and its original source, owner and deadline
preserved. Backend recovery passes; operator confirmation of one visible delivery is pending.
No runtime change or new model/test-suite run occurred. Cancelled REM-0009's original deadline
has not yet elapsed; its non-delivery observation remains pending.

**Case 6A checkpoint — September 21:** the operator screenshot shows pause acknowledgement
followed by `RC_PAUSED_BEFORE_0921`. [Read-only checks and restart evidence](tests/acceptance/manual-paused-restart-0921.json)
confirm durable PAUSED at 11:17:38 UTC; the marker occurs zero times across ten application
tables and container logs. At 11:19:32 UTC the same container/image/crypto volume restarted,
hydrated three conversations and connected with zero startup errors. The stored state remains
PAUSED with its original change timestamp. Post-restart marker, status, resume and subsequent
storage checks are pending. This checkpoint does not prove in-flight cancellation or absence
from provider request payloads; those were not observed. At 11:18:56 UTC, REM-0009 was still
cancelled/version 2 past its original deadline; visible non-delivery confirmation remains pending.

**Case 6A post-resume — September 21, 11:22 UTC:** the operator screenshot confirms the
post-restart marker, paused status response, successful resume and an empty personal open-action
list. Fresh checks confirm ACTIVE and zero occurrences of either `RC_PAUSED_BEFORE_0921` or
`RC_PAUSED_AFTER_0921` across the ten checked application tables and container logs. The
[updated evidence](tests/acceptance/manual-paused-restart-0921.json) passes the observed
PAUSED persistence, resume and no-marker-persistence journey. Live in-flight cancellation and
provider request payload exclusion were not demonstrated by this run; do not conflate the
storage/UI check with those stronger claims. SECURE repeat remains pending.

**Case 6B restart checkpoint — September 21:** [SECURE evidence](tests/acceptance/manual-secure-restart-0921.json)
confirms durable SECURE from 11:24:30 UTC and an open secure interval. The supplied synthetic
`RC_SECURE_BEFORE_0921` marker occurs zero times across ten application tables and container
logs. At 11:26:02 UTC the same staging container/image/crypto volume restarted successfully,
hydrated three conversations and connected with zero startup errors. SECURE and the original
open interval were preserved. Post-restart marker/status/resume checks and interval closure
remain pending; provider payload exclusion and live in-flight cancellation are not claimed.

**Open display defect:** reminder confirmations, snooze and list render times without a timezone,
which made a future deadline appear overdue beside the Wire client clock. Inspected create/snooze
formatters use server-local `toLocaleString`; the channel is configured UTC. Fix consistent explicit
zone display with regression checks before final acceptance; the elapsed scheduling evidence above
passes independently. The coordinated recovery test used the unchanged candidate.

1. **Round trip and reply targets.** Mention the bot with `status`, then send `my actions` and
   another `status` quickly as separate messages. Each reply must quote its own source. Check
   the current requester is addressed correctly. Confirm the registered app name and description
   use Wire Team Bot; the previous registry display was AI Team Bot (adamlow, staging), and
   registry branding needs an admin update if still unchanged.
2. **Decision attribution and corrections.** As @adamhuman, send `decision: use SQLite for the
   RC final ledger because setup is simple` and keep `DEC-A`. Ask `Who recorded DEC-A, and who
   made that decision?`: recorder must be Adam (Human), with maker unknown. Send `decision:
   Adam Low agreed to use Postgres for the RC final ledger because transactions are required
   supersedes DEC-A`; keep `DEC-B`. Ask for the current decision, rationale, recorder and maker:
   Postgres/transactions, Adam (Human) recorder, Adam Low maker. Send `revoke DEC-B RC final
   check finished` and ask again; neither decision should be active or automatically revived.
3. **Structured assignment and dates.** As @adamhuman, send `action: prepare the RC final
   checklist for @Adam Low by this Friday`, inserting an actual member mention. Keep `ACT-A`.
   For a September 21 run, `this Friday` is September 25 and `next Friday` is October 2.
   The earlier September 18 expectations remain specific to that date. As @adamlow_wire,
   ask `my actions` and `what am I responsible for?`; the owner must be Adam Low. Reassign with
   `ACT-A reassign to @Adam (Human)` using a real mention, set `ACT-A due next Friday`, then
   `ACT-A done`. Check the owner, next-week date, completion and removal from open lists.
4. **Passive feedback.** Without mentioning the bot, send `I'll send the RC final handover
   note tomorrow.` Wait for 📝 and inspect `my actions`. Send `I've sent the RC final handover
   note.` as the same owner; expect ✅ and removal from the open list. Verify exactly one action
   and the matching creation/completion audits, including the original qualified source.
5. **Combined commands and reminders.** In one message, send two bot-mentioned lines:
   `remind me in 20 minutes to check RC final cancellation` and `remind me in 20 minutes to
   check RC final snoozing`. Expect a split-message instruction and **zero** reminders from that
   source. Send the two lines separately; keep their IDs. Immediately cancel the first with
   `cancel REM-A`; snooze the second with `snooze REM-B 2 minutes`. Confirm the second arrives
   at its revised time and the first never fires. For recovery, create `remind me in 2 minutes
   to check RC final recovery` and tell the developer as soon as it is confirmed. The developer
   stops the bot until it is overdue, checks it remains pending, then restarts the same image
   and verifies receipt plus fired state. Do this coordinated interruption before more commands.
6. **PAUSED and SECURE.** Test each state separately. Send a synthetic ambient commitment and
   immediately mention `pause` (or `secure mode`); wait for confirmation. Send a unique marker
   such as `RC_PAUSED_BEFORE_0918`. The developer restarts the same image. Send
   `RC_PAUSED_AFTER_0918` while still blocked, then mention `resume`. Repeat with `RC_SECURE_...`
   markers. Markers must not reach later model requests, stored records, signals or audits.
   Capture logs/DB checks through the developer; silence alone is not proof. If the pre-pause job
   had already finished, do not claim that run demonstrated in-flight cancellation.
7. **Cross-channel denial.** In Demo for Anna create `action: keep the RC final scope marker`
   and retain its open ID. In Wire Team Bot Testing ask about that ID, then send `<ID> done`.
   Expect no record disclosure or mutation. The developer checks the original remains open with
   unchanged version and audit count; then close it in its original conversation.
8. **Quality and usefulness.** Review [the 20 source/record pairs and ten known answers](tests/acceptance/qa6-quality-review.md),
   including silent captures and the unknown-answer control. Record reviewer/date, corrections,
   useful answers out of ten, and whether the measured 7.7-second median/16.1-second slowest
   response and notification volume are acceptable. Try `catch me up`, `team actions` and
   `overdue actions` in the designated channel. Apply §5 thresholds; synthetic matching is not
   human approval. Existing multi-day simulation review remains unapproved.

After these checks pass, record the pilot team/channels, owner, start date and five working days
of feedback. Any privacy leak or wrong-target mutation blocks the pilot. Production deployment
remains outside this staging acceptance.

#### Second automated implementation step — 2026-09-18

The date discrepancy was a runtime bug as well as an evaluation problem. Chrono's forward-date
option promoted a date-only Friday to the following week once the implied noon passed. Parsing
now uses the conversation timezone, keeps today's date-only weekday on today (default noon),
and preserves explicit next-week requests. A future explicit time today stays today; past
explicit-time requests retain forward-date behaviour. Calendar target dates account for DST;
elapsed durations and explicit timezone expressions retain their specified instant. Existing
records are not migrated. Gap/fold disambiguation for ambiguous local times is not expanded.

The CLI can inject a parser reference instant and conversation timezone for synthetic framed
runs only; the Wire composition still uses the real clock. Network timers, processing queues,
and record creation timestamps remain real. The e2e report records each scenario's reference
instant/timezone and actual source events. Every scenario inventories stored decisions/actions/
reminders only after CLI exit and queue drain. Fifteen scenarios have mandatory exact fact/source/
qualified identity/status/date checks (including durable secure state); other inventories remain available for review without
being labelled checked. Generated IDs serve command substitutions, not stored-fact matching.

Expectation changes and their reasons:

- TC-PIPE-06 now explicitly says Alice will do the work, retaining the one-action dedup requirement
  and requiring the first source event. TC-PIPE-08 preserves both original ownerless messages
  and requires zero captures. No ownership guess is permitted to improve recall.
- TC-ID-03 asks who recorded the decision and, separately, who made it. Stored author must be
  `alice@cli.local`, with no invented maker. TC-DEC-07 now requires both Carol and Dave as makers,
  Alice as recorder, and the corresponding stored source/summary.
- TC-ACT-09/10/11 use fixed clocks and exact persisted deadlines. New TC-ACT-12/13 cover local
  Friday while UTC is Thursday, and explicit next Friday. Their assertions use concrete dates.
- A model judge still rejected correct Friday confirmations after an explicit policy clarification:
  [first run](tests/acceptance/step2-date-judge-before.json),
  [policy-clarified rerun](tests/acceptance/step2-date-judge-policy-report.json). Four deterministic
  command/list replies in TC-ACT-10/11 now require exact full text, plus exact stored facts,
  instead of asking a model to interpret fixed output. TC-DEC-06 and TC-STATE-03 subsequently
  received the same exact checks after the full run reproduced judge errors on their correct
  confirmations; stored names/source and durable secure state are also mandatory. Wrong date/owner, extra text or an extra
  record all fail. Natural-language answers remain model-judged; neither failed report is hidden.

Initial validation: 14/20 date cases failed before the parser fix; after it, **365 tests in 43
files passed**, including six isolated DB tests, plus build, production and e2e-harness strict
TypeScript checks, and lint. Environment remains Node 22.23.2/glibc 2.41 and isolated Postgres
16 + pgvector on port 55439. Focused real-model runs verify all affected stored facts; full
image regression followed, as recorded below.
[Focused checks](tests/acceptance/step2-focused-report.json) pass; the strengthened Friday test
[rejects the previous image](tests/acceptance/step2-old-image-regression.json) with its wrong
next-week stored date and confirmation. Original 57/60 and step-one 58/60
reports remain unchanged. No classifier/extractor change, new dependency or staging deployment.

The first full image run was **61/63** ([report](tests/acceptance/step2-e2e-report.json)); all nine
then-mandatory stored checks passed. The two failures were fixed-output judge errors in
TC-DEC-06 (explicit Alice/Bob agreement rejected as a recorder/maker confusion) and TC-STATE-03
(the existing acknowledgement rejected for not literally saying "secure mode").
[Focused reruns](tests/acceptance/step2-final-focused-report.json) pass with exact text plus
persisted facts/state. That stage retained the same runtime image for the next full run.
The fixed capture sample also completed: [report](tests/acceptance/step2-capture-report.json),
20 expected/20 stored/20 correct facts (10 decisions, 10 actions), zero duplicates and stored/log
privacy markers. Human approval remains pending.

Evaluator calibration follow-up:

- The next full run was **60/63** ([uncalibrated rerun](tests/acceptance/step2-final-e2e-report.json)).
  All eleven mandatory storage/state checks passed. Three correct natural answers were rejected:
  Redis/TTL rationale, the read-only reminder follow-up, and Bob's requester identity.
- A [12-case calibration fixture](tests/acceptance/judge-calibration-fixture.json) pairs six real
  correct answers with six deliberately wrong ones (wrong date, wrong owner, wrong makers,
  invented maker, missing rationale and fabricated reminder scheduling). The existing small
  judge scored [10/12](tests/acceptance/step2-judge-small-report.json). The existing response model
  scored [11/12 after strict protocol review](tests/acceptance/step2-judge-strong-initial-report.json):
  one malformed verdict was rejected, not counted as a successful negative.
- The judge now shares the runtime's bounded unsupported-temperature compatibility behaviour,
  requires one valid verdict line, fails closed, and retries malformed output only once. Valid
  FAILs are never retried to obtain a PASS. Every verdict and malformed attempt is retained in
  the e2e report. Network/format errors remain failures.
- With that protocol, the stronger configured model passes [12/12 calibration cases](tests/acceptance/step2-judge-strong-report.json),
  including all six negative controls. Acceptance runs explicitly set
  `JEEVES_JUDGE_MODEL=claude-opus-5`; application model slots and the default judge fallback remain
  unchanged. This is evaluator calibration using an existing model, not an application provider
  migration. Initial calibration encountered an explicit unsupported-temperature HTTP 400 before
  the compatibility fix; provider bodies/credentials were not logged.
- TC-QA-05's old assertion incorrectly allowed a read-only Q&A path to create a reminder. It now
  requires coherent text guidance without claiming a write, and zero stored captures. TC-ID-06
  now also checks both actual owners, source events and deadlines. No false ownership/write is
  accepted to improve a score. These additions bring mandatory storage/state checks to thirteen.
- Latest deterministic validation: **369 tests in 43 files**, six isolated DB tests, build,
  production/harness strict type checks and lint passed. The subsequent calibrated runs are
  recorded below; earlier failing reports remain intact.

The first calibrated full run was **62/63** ([report](tests/acceptance/step2-calibrated-e2e-report.json));
all thirteen mandatory stored-record/state checks passed. TC-ID-04 received two empty evaluator
responses; the actual reminder confirmation, persisted Alice/Bob ownership and caller-filtered
list were correct on inspection. TC-ACT-12 also had an empty first verdict, followed by a valid
PASS. These are retained evaluator failures/retries, not hidden application failures.
The 150-token evaluator allowance was increased to a bounded 512 tokens; provider finish reasons
are now retained for diagnosing truncation. The earlier response metadata was not retained, so
its precise cause is not claimed. The [focused reminder rerun](tests/acceptance/step2-budget-focused-report.json)
and [all twelve controls](tests/acceptance/step2-budget-calibration-report.json) pass. Fresh build,
production/harness type checks, lint and **370 tests in 43 files** pass, including six isolated
DB tests. The subsequent full run retained the same application image and assertions.

Raw review of the next [63/63 assertion pass](tests/acceptance/step2-acceptance-e2e-report.json)
found two uncovered answer errors: TC-PIPE-05 suggested December 31 for the current quarter on
September 18, and TC-PERSONA-01 said "you decided" when only the recorder was known.
[Both findings and original outputs are preserved](tests/acceptance/step2-raw-review-findings.json).
That green score was **not accepted as final**. The answer guidance now also prohibits invented
calendar dates in suggested commands and unsupported maker attribution in pronouns/introductory
prose. Both scenarios have stricter answer assertions and post-process stored-source/identity
checks (fifteen mandatory scenarios in total). [Both corrected journeys pass](tests/acceptance/step2-answer-focused-report.json),
and [both saved bad answers fail the new assertions](tests/acceptance/step2-answer-negative-controls.json).
Fresh build/type-check/lint and all **370 tests** pass. Runtime `ae618ff` was then built and
validated in the final runs below.

The release build reports [three high dependency audit entries](tests/acceptance/step2-dependency-audit.json)
for one recursive-object stack-exhaustion advisory propagated through `deepmerge-ts`,
`@prisma/config` and `prisma`. No dependency was changed. Inspection places `deepmerge-ts` in the local Prisma TypeScript/JavaScript
configuration loader; the application has no direct import of it or `@prisma/config`. No path
from Wire/model input to that loader was identified. This is a recorded dependency limitation,
not an observed message-input exploit or a claimed clean security audit.

**Final step-two evidence:** [validation summary](tests/acceptance/step2-validation.json).
Runtime/harness commit `ae618ff3c7b5cda642e603ed8a755076bdf1655d`, image
`wire-team-bot:v3-rc-ae618ff`, image ID
`sha256:4faa5df2a11d540e20659d89cb439755715060cb859f6db264a2c038bdb5abd0`.

- [Full immutable-image run](tests/acceptance/step2-final-runtime-e2e-report.json), `mu74v4ij`:
  **63/63**, all fifteen mandatory storage/state checks pass, no malformed judge attempts.
  Post-exit inventory contains 14 decisions, 26 actions and 8 reminders; all inventories were
  inspected. These inventory totals are not an extraction-quality score. Raw answer review
  confirms the corrected attribution, missing-deadline guidance, date boundaries, requester
  identity and read-only reminder follow-up. Original/failing reports remain unmodified.
- [Final unchanged capture sample](tests/acceptance/step2-final-capture-report.json):
  **20 correct / 20 stored / 20 expected**, separately **10/10/10 decisions** and **10/10/10 actions**;
  precision and recall **100% on this small synthetic fixture**, zero duplicates. Ten captures
  were silent. All records match expected source events/facts/owners after processing exits;
  no reply-ID scoring. Zero stored/diagnostic privacy markers, zero unsolicited text replies,
  five capture reactions. The ten known answers contain the expected facts and the unknown
  budget question is refused. Human correctness/usefulness approval remains pending.
- Eleven answer requests including the unknown question: median **7,698 ms**, p95/maximum
  **16,084 ms**, measured while the quality sample and isolated e2e suite shared the configured
  provider. One malformed query-analysis response used the existing safe fallback; embeddings
  were intentionally disabled. App model slots/dependencies are unchanged; only the evaluator
  uses the documented judge override. Simulation was not rerun: classifier/extractor/pipeline
  code did not change, and the existing simulation golden file still awaits human review.
- Build, production and harness strict type checks, lint, and **370 tests in 43 files** pass,
  including six real isolated Postgres/pgvector tests. No shared DB reset, historical-record
  migration, staging activation or production deployment was performed in this step.

**Next:** QA-7 Wire/UI and human-quality acceptance using the pinned staging candidate and
the exact manual packet below. QA-6 activation is now recorded below. Keep the candidate pinned during
manual QA; do not start P3 until those gates pass. Existing dates are not rewritten, date-only
weekday deadlines still default to noon, DST gap/fold ambiguity remains outside this fix,
and model instructions do not guarantee every future answer. Dependency limits are recorded
above. Production deployment is not part of this work.

Reproduce the calibrated full suite without starting a Wire client (the isolated test database
must already be running and migrated):

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" \
  --env-file .env.staging -e JEEVES_JUDGE_MODEL=claude-opus-5 \
  -e DATABASE_URL=postgresql://wirebot:synthetic-only@127.0.0.1:55439/wire_team_bot_test \
  -e JEEVES_EMBEDDINGS=off -e NODE_PATH=/validation/node_modules \
  -v "$PWD/tests":/app/tests:ro \
  -v "$PWD/node_modules":/validation/node_modules:ro \
  -v "$PWD/tsconfig.json":/validation/tsconfig.json:ro \
  --entrypoint node wire-team-bot:v3-rc-ae618ff \
  /validation/node_modules/ts-node/dist/bin.js --transpile-only \
  --project /validation/tsconfig.json /app/tests/e2e/runner.ts --json
```

Use the same container/environment and substitute `/app/tests/e2e/calibrateJudge.ts` for
`/app/tests/e2e/runner.ts --json` to repeat the twelve evaluator controls. Calibration checks the evaluator,
not the app; keep its result separate from the 63 application scenarios.

#### First automated implementation step — 2026-09-18

- Both structured and semantic decision retrieval expose the recorder separately. They never
  fall back from missing `decidedBy` to the author. The answer prompt names makers only from an
  explicit decider field or unambiguous named makers in the stored summary; unknown makers stay
  unknown. Existing records and IDs are preserved.
- ACTIVE routing rejects recognised combined explicit commands before buffering, model calls,
  state changes or domain writes, with a native reply asking for one command per message. The
  guard understands structured qualified mentions and inline-code commands, including formatting
  around only a record ID. It preserves the
  existing PAUSED/SECURE handling, single commands, multiline prose and fenced examples. This
  is bounded explicit-command recognition, not general natural-language batch execution.
- Red baseline: 14 new attribution/router cases failed; 107 existing router cases passed.
  After the fixes: build, `tsc --noEmit`, lint and **334 tests in 41 files passed**, including
  six real DB integration tests. Environment: Node 22.23.2 / Debian trixie container,
  isolated Postgres 16 + pgvector on port 55439, `INTEGRATION_TESTS=1`; no shared DB reset.
- The unchanged TC-DEC-07 now answers **Recorded by Alice; Decided by Carol and Dave**:
  [focused e2e output](tests/acceptance/step1-dec07-report.json). The
  [focused fixture](tests/acceptance/step1-fixture.json) and
  [real-model report](tests/acceptance/step1-report.json) also show an unknown decision maker
  explicitly distinguished from recorder Alice. Answers inspected directly, not accepted solely
  from the model judge. One malformed query-analysis output used the existing safe fallback;
  answer and stored-record checks still passed. Embeddings were off; semantic formatting was
  covered by mocked tests. Model slots/fallbacks are recorded without endpoints or credentials.
- [Post-drain storage inspection](tests/acceptance/step1-storage-check.json): 2 expected/2 stored
  decisions matched by fact and source, no actions, exactly 2 reminders from the separate source
  events, no combined-message writes, 4 matching creation audits. Recorder is `alice@cli.local`,
  both explicit decider arrays are empty, and decision context arrays are empty. This small
  regression sample is not the pilot's 20-event quality sample or human approval.

Final step-one runtime is `1ef4bf2d36d18cd230752a4001f90358374f2f19`, built as
`wire-team-bot:v3-rc-1ef4bf2`; image ID
`sha256:2788bfad05b9d2bc6af5dfff32853037561a9054a78ded248ba3aa78b06ba3d2`.
The [immutable-image focused report](tests/acceptance/step1-image-report.json) and
[post-drain image storage checks](tests/acceptance/step1-image-storage-check.json) repeat all
focused checks successfully on that compiled runtime. The initial report above records the
pre-commit working tree; its runtime was committed as `caa4dd1`, followed by the inline-ID guard
fix in `1ef4bf2`. No image was deployed, and no historical record was rewritten.

Full unchanged e2e run `mu70wa2r` against that image: **58/60**
([raw results](tests/acceptance/step1-e2e-report.json)).
[Post-run inventory](tests/acceptance/step1-e2e-storage-check.json) includes all 15 decisions,
23 actions and 8 reminders, including silent captures. These counts are an inventory, not an
extraction-quality score. Direct storage/answer review confirms:

- TC-DEC-07 correctly separates Alice as recorder from Carol/Dave as named makers.
- TC-PIPE-06 fails its existing positive dedup expectation: the ownerless statements produced
  no action. It needs an explicit-owner positive case plus the retained negative case in QA-3.
- TC-ID-03 fails the judge's conflated maker/recorder expectation. Alice is the stored recorder,
  with no explicit makers; the answer correctly says maker unknown.
- TC-ACT-11 passed the model judge, but the same-Friday storage check **failed**: the deck action
  belongs to Bob and is due **2026-09-25T12:00:00Z**, not **2026-09-18T12:00:00Z**. This run occurred
  after noon on Friday 18 September, unlike the earlier morning run. Relative-date semantics,
  scenario clock/timezone and parser behaviour must be reconciled in QA-3; do not count this as
  validated date correctness just because the judge passed. TC-ACT-10 also passed the judge.

The first partial full run was stopped after the inline-ID formatting edge case was found;
only the completed immutable-image run above is counted. Existing e2e scenarios, judge,
acceptance evaluator and scoring code were not changed. No full 20-event quality sample or
simulation was rerun in this bounded step; classifier/extractor/pipeline code is unchanged.
At the end of step one, QA-3 and subsequent acceptance work awaited Adam's confirmation.

Repeat the focused check with the existing acceptance runner in the isolated test container:
`EVALUATION_FIXTURE=tests/acceptance/step1-fixture.json EVALUATION_REPORT=/tmp/step1-report.json npm run test:acceptance`.
Inspect all stored sources after drain and the two attribution answers; then rerun the unchanged
full e2e suite. No evaluator expectation has been relaxed for this step.

Repository inventory (2026-09-18): `main` is the only active branch; PRs #8 and #9 are closed.
Issue #7 described obsolete composite-button confirmation UI, which the current text-command
PoC does not require. It is closed as not planned; there are no open issues or PRs. Its history
is retained, and it is not an unimplemented release feature. The following tags are recovery snapshots, not merge queues:

| Archive tag under `archive/2026-09-18/` | Preserved work | Why it is outside the active candidate |
|---|---|---|
| `docs-app-goals` | Separate goals document and earlier docs changes | Superseded by this single plan and current README. |
| `configurable-bot-name` | General configurable-name implementation | Deferred in the scope table; fixed product branding is sufficient for QA. |
| `v3.0` | Broader redesign including alternate model/queue stacks, seed loading and general intent execution | Conflicts with the current bounded PoC scope and dependency constraints. |

Commit author/committer identity is normalized to Adam Low <adam.low@wire.com>, with unwanted
assistant attribution/session links removed from messages. History rewrite changes commit IDs,
not application source trees. [The commit mapping](tests/acceptance/history-map.json) maps
original full IDs to their rewritten counterparts. Existing image tags and evidence reports
retain original IDs/configuration so historical measurements are not misrepresented as new runs.
All 159 rewritten commit trees were compared with their originals and are identical; all three
archive tags retain the same source snapshots. Invalidated signature headers were removed.
A verified private pre-rewrite Git bundle is retained outside the repository at
`/tmp/wire-team-bot-history-_kaz61by/before-rewrite.bundle`. This documentation-only operation
does not count as a fresh runtime, model or manual QA run. GitHub may cache contributor
statistics or retain old closed-PR commit snapshots independently of current branch/tag history.

**Attribution verification corrected — 2026-09-21:** the authenticated account is
`adamlow-wire`, and GitHub's repository contributors API lists only that account. Published
`main` and all three archive tags match the inspected local refs. All reachable commit authors,
committers and archive taggers are Adam Low <adam.low@wire.com>; no unwanted co-author trailers
or assistant/session attribution were found in commit messages. Repository-local Git name/email
are pinned to that identity. No additional history rewrite or branch/tag deletion was needed.

**The visible contributor cleanup is nevertheless incomplete.** Adam's screenshot shows three
contributors. A fresh unauthenticated read of GitHub's repository page and `/_sidebar` endpoint
on September 21 confirmed `contributorCount: 3`, including the two historical accounts, while
`/repos/adamlow-wire/wire-team-bot/contributors` returns only the owner. The previous completion
claim verified the API/history but failed to verify the separate repository sidebar. This is
not just an old screenshot. GitHub's
[official contributor troubleshooting](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors#contributor-data-is-stale-after-history-changes)
says contributor displays can remain stale for about 24 hours after a history rewrite and to
contact Support if incorrect data persists beyond that. The rewrite was September 18, so the
support escalation is applicable. A request with both endpoint results is prepared locally at
`/tmp/wire-team-bot-github-support.md`; it has **not** been submitted. No repository deletion,
default-branch switching, additional force-push or hiding of the widget was performed. Mark
this task complete only when the visible sidebar is also correct. Staging and app QA are unchanged.

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

### Earlier staging candidate disposition — 2026-09-18

This records the earlier staged runtime and its then-open defects. The later automated QA
section above supersedes its code, validation and staging status. These paragraphs retain the
earlier candidate's evidence and then-open defects.

**Packaged for staging; acceptance incomplete, not pilot ready.** Runtime `4bc7e1f` is available
as `wire-team-bot:v3-rc-4bc7e1f` and was active in staging at that point. No production deployment
was performed. Recorder/decider attribution, combined-command guidance, human review and remaining
Wire gates were still open for that earlier candidate.
[Release evidence](tests/acceptance/release-evidence.json) records configuration and boundaries.

- Fresh build, type-check and lint pass. **304 tests pass** in 39 files, including six isolated
  Postgres/pgvector tests, reaction mapping and native-reply concurrency/scope/lifecycle contracts.
- Immutable-image real-model e2e: **57/60**, original assertions unchanged. Full outputs and
  targeted rechecks are in [e2e-report.json](tests/acceptance/e2e-report.json).
  On `4bc7e1f`, `TC-PIPE-06` still expects ownership inferred from “we need”. `TC-ACT-11` stores
  the correct Bob owner and Friday September 18 12:00 UTC deadline; the judge insists “this Friday”
  means September 25. Calendar/DB inspection confirms Friday. `TC-ID-03` correctly says Alice
  recorded the decision, but the judge rejects “recorded” as “made”; stored author is Alice.
  Its unchanged targeted rerun passes. `TC-ACT-10` passes this full run. Preserve the original
  **57/60** score and failures for adjudication; no assertions, dates or full-run results replaced.
- Raw output inspection is still required: `TC-DEC-07` now receives a passing judge verdict
  while continuing to label recorder Alice “Decided by” alongside the named Carol/Dave decision.
  **The attribution bug remains open despite that verdict.** `TC-ID-06` and `TC-QA-05` pass
  this run; historical failures remain in Git.
- Reaction lifecycle passes with real models and an isolated DB: 📝 on the capture source,
  ✅ on its completion source, no reaction for explicit creation or ordinary chat. All stored
  records were inspected after drain: two expected actions, Bob's passive one done/version 2,
  Carol's explicit one open, and three action audits linked to the expected source events.
  See [reaction-report.json](tests/acceptance/reaction-report.json). The operator confirmed both emojis display correctly in Wire on September 18.
- Fresh fixed sample at `7384b39`: **20 correct / 20 total / 20 expected**, 10 decisions and 10
  actions, **100% precision / 100% recall**, zero duplicates or stored/log privacy markers.
  Baseline remains 10/10/20 (100%/50%). Five passive actions received 📝; unsolicited text replies
  remain zero. This is a small synthetic sample, **not human-approved quality**. All ten known
  answers and the unknown-answer refusal match their expected facts on assistant inspection.
  [reaction-quality-report.json](tests/acceptance/reaction-quality-report.json) preserves source
  events, records, replies and separate reactions. Built-checkout runtime was used for this
  sample; the full e2e above used the immutable image. Human correctness/usefulness review pending.
- Reply-event median **7.308 s**, known-question median **8.388 s**, slowest **9.516 s**. No model
  degradation observed in this sample; embeddings-off warning only. Times include queue drain.
- Chat configuration: classify/judge `claude-haiku-4-5`; extract, summarise, query analysis,
  respond and complex synthesis `claude-opus-5`, with the same per-slot fallback models.
  Embeddings **off**, configured dimension 2560. DB vector behaviour was exercised with synthetic
  vectors; enabling real-provider embeddings requires its own smoke check.
- Earlier `bde0d0a` image CLI checks verify decisions, named actions with deadlines, PAUSED and SECURE
  across process restarts, resume and list retrieval. Persisted inspection finds one decision,
  one correctly owned/dated action, a closed secure range and no excluded marker. Earlier
  candidate smoke also exercised queued cancellation and model-backed recall. These are
  CLI/DB checks, not Wire transport evidence.
- Fresh simulation at `7384b39` completed all 57 source events: six decisions, seven actions,
  one reminder, six 📝 reactions and one ✅ reaction. No privacy markers or model errors. The
  existing unsolicited-message heuristic counts one reply, inspected as the confirmation of an
  explicit reminder command. The stored inventory is local and unreviewed; `golden.json` is still
  an instruction placeholder. **No simulation precision/recall claim.**

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

That update activated `wire-team-bot:v3-rc-2ba7a1f`; database and crypto volumes were preserved.
Fresh readable snapshots and override: `/tmp/wire-v3-caller-backup-tbxaea25/`. Startup connected,
hydrated the member cache and reported zero SDK errors and zero container restarts. The next
operator screenshot confirms both mentioned `my actions` and `What am I responsible for here?`
correctly return Adam Low’s two open actions, including `ACT-0002` with its September 18 deadline.
The Q&A identifies Adam Low as the current requester, with no incorrect Adam (Human) disclaimer.
Caller-specific list/Q&A and post-restart receive/decrypt/reply now pass on this image. This
does not yet verify reassignment, deadline changes, completion, reminders or privacy-state restart.
Rollback to the preceding image while keeping current volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-owner-backup-QFDF2p/candidate.override.yml up -d --no-deps --no-build jeeves`.

Pasted-command fix and staging update (2026-09-16 18:27 UTC): `a51a7af` accepts a leading
single-line inline-code span around an ACT ID, command prefix or whole command, after stripping
the actual bot mention. Person mentions already route correctly without that formatting.
Action-status questions now use record retrieval; explicit `status` still returns channel status.
Build/type-check/lint and 233 tests passed; that image’s full e2e run was 55/57.
The [formatted-action report](tests/acceptance/formatted-action-report.json) retains initial
failures and a passing real-model journey. Post-process DB inspection confirms one action,
Bob ownership, tomorrow deadline, done status, version 4 and four creation/update audit entries.
No classifier/extractor/pipeline change was made; the earlier quality sample remains attributed.

That update activated `wire-team-bot:v3-rc-a51a7af`. Private readable snapshots and its override are
in `/tmp/wire-v3-format-backup-xy3x0138/`. Existing database/crypto volumes were preserved;
startup connected and hydrated one conversation with zero SDK errors. `ACT-0002` remained
unchanged before the update. The operator’s next screenshot confirms reassignment to Adam (Human).
Scoped DB inspection verifies the qualified @adamhuman owner, version 2, open status, unchanged
Friday deadline and exactly one reassignment audit event attributed to Adam Low. Pasted-command
reassignment and the post-restart round trip pass. On September 17 the operator screenshot
confirms deadline change and completion. Scoped DB inspection verifies owner @adamhuman,
deadline `2026-09-18T09:45:44.790Z`, status `done`, version 4 and four audit entries
(creation, reassignment, deadline, completion). The deadline and completion updates are
attributed to Adam Low. The core action journey now passes on Wire; unknown/ambiguous-owner
refusal and the remaining reminder/privacy/correction journeys still need Wire acceptance.
Rollback, retaining volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-caller-backup-tbxaea25/candidate.override.yml up -d --no-deps --no-build jeeves`.

Reminder formatting fix and staging update (2026-09-17 10:03 UTC): `f3b2eed` removes the
ACT-only restriction on leading inline-code normalization. Existing text-command matching now
handles pasted reminders, decision corrections, lists and addressed privacy controls as well.
Twelve failing-before cases reproduced the gap; negative tests retain prose/fence/multiline
exclusions, and PAUSED/SECURE resume still requires a qualified actual mention. Build/type-check/
lint and 248 tests pass. Immutable-image full regression is 56/58, with the same ambiguity and
caller-judge discrepancies above. The [formatted-reminder report](tests/acceptance/formatted-reminder-report.json)
records a passing real-model create/list/snooze/cancel journey and post-process DB/audit inspection:
one reminder for Alice, snoozed trigger matching its audit entry, cancelled status, version 3,
three audit entries. This does not establish live reminder delivery.

That update activated `wire-team-bot:v3-rc-f3b2eed`, with the same database and crypto volumes.
Readable snapshots and override: `/tmp/wire-v3-reminder-format-backup-gjeyvsyr/`. No reminders
were pending before the switch; startup connected, hydrated one conversation and reported zero
SDK errors. The failed Wire reminder attempt created no record. The subsequent operator screenshot
confirms `REM-0001` creation and delivery two minutes later. Scoped DB inspection verifies
@adamhuman as author/target, trigger `2026-09-17T10:09:50.637Z`, fired status, version 2 and
creation/firing audit entries. The saved fired update followed the trigger by 118 ms. The
confirmation displays UTC (10:09); the webapp screenshot displays UK local time (11:09).
This retry shows a plain command; inline-code reminder routing remains verified automatically.
Cancellation, snooze and overdue-during-downtime recovery still need Wire acceptance;
restart recovery is covered below.
Rollback, retaining volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-format-backup-xy3x0138/candidate.override.yml up -d --no-deps --no-build jeeves`.

Pending-reminder restart check (2026-09-17 11:36 UTC): the operator created `REM-0002`
using a code-formatted command, confirming the inline-code creation fix on Wire. Scoped DB
inspection found it pending for @adamlow_wire, due `2026-09-17T11:45:29.304Z`, version 1.
The same pinned container was restarted at `11:36:25.509Z`, preserving database and crypto
volumes. Fresh startup logs confirm one pending reminder rehydrated, one conversation hydrated
and the Wire client listening, with zero SDK errors. The only pending reminder in the test
conversation was `REM-0002` with its original due time and version. The subsequent operator
screenshot confirms delivery at 12:45 UK time. Scoped DB inspection verifies fired status,
version 2, unchanged trigger and exactly one firing audit entry (two entries including creation).
Fired state was saved at `11:45:29.433Z`, 129 ms after the trigger. **Restoration and delivery
after restart pass.** A reminder becoming overdue during downtime remains a separate pending check.

The operator also reproduced two explicit reminder requests in one message falling into Q&A,
which misleadingly described the message as a question. Current routing expects one command
per message. This combined-command failure is recorded for a bounded routing/guidance fix
after the active cancellation/snooze checks; no batch executor is implied. Separate messages
created `REM-0003` (cancellation) and `REM-0004` (snoozing), both pending for @adamlow_wire
at the scoped DB check on September 17, 14:30 UTC. The operator missed the mutation window;
a later scoped check found both fired at their original deadlines, version 2. Cancellation and
snooze remain untested and require fresh reminders.

Named-assignment fix and staging update (2026-09-17 15:05 UTC): `17b8e42` adds the bounded
bot-addressed `@member needs to <task> by <deadline>` variant to the existing audited action
use case. The demonstrated preceding project-deadline clause supplies no guessed owner or
second action; only the named assignment and its own deadline are persisted. Questions,
negation, hypothetical wording and multiple assignments do not use this new write route.
PAUSED/SECURE remain checked first. Unknown/ambiguous names use existing member resolution.
That build/type-check/lint and 260-test run passed; its immutable-image e2e was 56/59.
The [named-assignment report](tests/acceptance/named-assignment-report.json) verifies exactly
one stored Bob-owned slide-deck action, Friday deadline, Alice creator and one audit entry.
Classifier/extractor/pipeline and answer prompts are unchanged; the earlier quality sample
remains attributed to its measured image. This is not general natural-language intent execution.

At 15:05 UTC staging was updated to `wire-team-bot:v3-rc-17b8e42`, preserving database and crypto volumes.
Readable snapshots and override: `/tmp/wire-v3-assignment-backup-vcoikohf/`. No reminders were
pending before the switch. Startup connected, hydrated two conversations and reported zero
SDK errors. The subsequent operator replay exposed the structured-mention regression below. Previous rollback command:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-reminder-format-backup-gjeyvsyr/candidate.override.yml up -d --no-deps --no-build jeeves`.

Structured mention regression (2026-09-17): the next demo used `@member really needs to`.
Three before-fix contract cases fail: routing dropped the qualified mention ID, and the adverb
became part of the display-name lookup. SDK metadata confirms both designated accounts are
members of **Demo for Anna**, `8791c80e-8209-4509-9c33-360e83b44c62@staging.zinfra.io`.
Runtime `ad01b3a` binds validated UTF-16 person spans before command parsing and carries the qualified
identity through natural/explicit action creation and reassignment. The resolver verifies exact
membership in the qualified conversation without falling back to the label. Labels remain for
display; plain-text names retain existing ambiguity checks. The synthetic CLI now represents
roster @mentions as structured fields too. No classifier/extractor/pipeline changes.
Fresh build/type-check/lint and **278 tests** (including six isolated DB tests) pass. An initial
model invocation omitted provider settings and stopped at its configuration preflight; the
configured TC-ACT-11 run passes. Post-process DB inspection finds exactly one Bob-owned action,
Alice creator, Friday September 18 12:00 UTC deadline, version 1 and one creation audit. No
project-context clause or internal mention token is retained. The immutable-image run is 56/60 as detailed above. Staging activation preserves the existing
volumes; fresh backup/override: `/tmp/wire-v3-mention-backup-8fiicc11/`. Startup at 15:36:12 UTC
hydrated two conversations and connected with zero SDK errors. Operator replay passed on
September 18, with stored-record verification below. Rollback using `/tmp/wire-v3-assignment-backup-vcoikohf/candidate.override.yml` with
the README compose command. Detailed stored-record evidence is in the
[structured-mention report](tests/acceptance/structured-mention-report.json).

Wire smoke continuation (2026-09-18, same `ad01b3a` image): the operator reports tests 1–3
completed and has created the overdue-recovery reminder for test 4, in **Demo for Anna**.
Scoped DB inspection confirms `ACT-0004` is the deck action, owned by qualified @adamlow_wire,
created by @adamhuman, due September 18 12:00 UTC, open/version 1. Structured mention assignment
now has actual Wire evidence. `REM-0005` is cancelled/version 2 with creation/cancellation audit
entries; its original deadline is 06:31:04.849 UTC. `REM-0006` was initially pending/version 2, rescheduled
from 06:31:38.390 to 06:51:51.637 UTC with a matching snooze audit. Cancellation and snooze
mutations pass. Later inspection after both deadlines finds `REM-0005` still cancelled with no
firing audit; `REM-0006` sent at its revised deadline and was saved fired/version 3 at
06:51:51.843 UTC, 206 ms after the trigger, with one firing audit. Final Wire UI confirmation
of cancellation non-delivery and snoozed receipt remains pending.
`REM-0007` was initially pending/version 1, due 06:27:40.003 UTC. The staging bot was stopped cleanly at
06:23:12.610 UTC with existing volumes/image retained. At 06:27:50.149 UTC it was still stopped,
and the overdue reminder remained pending/version 1 with no firing audit. The same container
restarted at 06:27:50.197 UTC. Outbound send succeeded; the reminder was saved fired/version 2
at 06:27:51.812 UTC, with exactly one firing audit and its original trigger unchanged. Startup
rehydrated two reminders and two conversations, connected, and reported zero SDK errors.
**Overdue recovery, successful send and durable status pass; operator UI receipt confirmation
remains pending.**
No build or automated suite was rerun for this operational test.

Decision corrections on Wire (2026-09-18, `ad01b3a`): the operator screenshot confirms SQLite
`DEC-0003` was superseded by Postgres `DEC-0004`, with correct current-decision/rationale recall,
then `DEC-0004` was revoked. Follow-up correctly reports no active decision and does not revive
SQLite. Qualified Demo for Anna DB inspection confirms `DEC-0003` superseded/version 2 with
`supersededBy=DEC-0004`, `DEC-0004` revoked/version 2 with `supersedes=DEC-0003`, empty context
arrays, and four create/update audit events attributed to Adam Low. **Test 5 passes.** This does
not resolve the separate recorder/decider attribution bug; both roles coincide in this test.

Passive Wire capture (2026-09-18, `ad01b3a`, Demo for Anna): the unmentioned checklist
commitment was silently captured as `ACT-0005`. Post-processing DB inspection at 08:34 UTC
finds one matching open/version 1 action owned and authored by qualified Adam Low, due Friday
September 18 12:00 UTC. Its source event produced exactly one action and one creation audit;
the audit retains only the source ID. The operator screenshot shows the unmentioned source,
not a bot acknowledgement. **Capture passes; passive completion and subsequent list check
remain pending.** This is one live smoke event, not a fresh aggregate quality evaluation.

User-approved feedback change (2026-09-18): silent checklist capture left the operator unsure
whether anything happened. Add post-persistence 📝/✅ reactions for passive action capture/completion
through the existing outbound port, with mocked/contract coverage, real-model stored-record
checks, simulation replay and a live Wire reaction check. Implementation is present: 296 unit/
contract/isolated-DB tests, build/type-check/lint pass. The four-event real-model lifecycle passes:
📝 on capture, ✅ on completion, no reaction for explicit creation or noise. Post-process inventory
finds both expected actions, the passive one done/version 2, and all three source-linked action
audits. Initial tests found a stopped isolated DB (restarted without reset) and new assertions
that incorrectly counted signal audits as action audits (corrected to assert action audits).
Full immutable-image e2e is 57/60 and simulation is complete as detailed above. The operator confirmed both reactions work in the Wire webapp. Scoped post-processing DB
inspection finds the emoji smoke checklist as `ACT-0006`, done/version 2, source
`550e5ccf-e384-4535-8f2d-6a7a364474d9`, updated at 09:01:45.912 UTC. Reactions are best effort, with no durable retry or backfill; failed delivery
does not undo or repeat a persisted write. Both emojis share one reaction set for mixed outcomes.
Staging started the pinned image at 08:57:46.917 UTC, preserved existing volumes, hydrated two
conversations and connected with zero SDK errors. Fresh readable database/crypto backups and
override: `/tmp/wire-v3-reactions-backup-i3egzaxn/`. No reminders were pending before the switch.
Rollback with current volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-mention-backup-8fiicc11/candidate.override.yml up -d --no-deps --no-build jeeves`.

Native reply request (2026-09-18): direct responses carried source IDs through the use cases,
but the outbound adapter ignored them. Runtime `4bc7e1f` uses the SDK's native quote ID and
integrity hash for the exact incoming message and qualified conversation, including prompt
text and error replies. Metadata exists only during the handler and contains no source body;
it is removed on success/failure. Missing metadata and unsupported self-deleting sources use
ordinary text. Scheduled reminders remain standalone. Eight regressions cover SDK hashes,
mentions, overlapping channels/queued commands, scope, cleanup, errors and unsupported sources.
Fresh build/type-check/lint and **304 tests**, including six isolated DB tests, pass. The pinned
image is built; full unchanged real-model regression finished **57/60**, with details above. Staging started at 09:15:08.035 UTC,
hydrated two conversations and connected with zero SDK errors. Existing volumes were retained,
with readable backups/override in `/tmp/wire-v3-replies-backup-_bfgw1o8/`. The operator screenshot
confirms the native quote of Adam Low’s “my actions please?” question, including correct source
text/author. The answer shows ACT-0005/4 and omits completed emoji-checklist ACT-0006. Native
reply display and open-list removal pass; live two-message correlation remains pending.
Rollback with existing volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-reactions-backup-i3egzaxn/candidate.override.yml up -d --no-deps --no-build jeeves`. No extractor/classifier/pipeline change; quality and simulation results
above remain attributed to `7384b39`, not reported as fresh runs for this transport-only change.

Remaining entry checks, in order:

1. A named reviewer reviews the fixed sample’s stored records/source events, all ten answers
   and unknown-answer output; record reviewed numerators and denominators here (thresholds above).
   Review simulation misses/false positives using `npm run simulate:review` as supporting evidence.
2. Fix the reproduced recorder/decider attribution error, then adjudicate the other three
   e2e failures above. Preserve raw results; changed behavior requires a regression run. Review latency and unsolicited output with the team.
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
| 2026-09-16 | Pasted reassignment formatting failure | Operator screenshot shows inline-code action prefix followed by a person mention and a misleading model explanation. Scoped DB inspection confirms ACT-0002 remains open, owned by Adam Low, version 1. Three formatted variants reproduce missed routing; plain text with person mention passes. Router now unwraps a leading single-line inline-code ACT command prefix; seven contract cases cover formatting and non-command boundaries. The new CLI journey also reproduced action-status questions being intercepted as channel status; channel status now requires an explicit command. The judge receives evaluation time for relative-date assertions; assertions are unchanged. | Real-model command journey and full release-image regression, then repeat Wire reassignment |
| 2026-09-16 | Formatted-action fix validated and staged | `a51a7af`: 233 tests, build/type-check/lint pass; real-model action journey and stored owner/deadline/status/audits pass. Immutable-image full regression 55/57: ambiguous-owner discrepancy and caller judge false negative; caller isolated rerun passes unchanged. Staging connected with preserved volumes and readable backups. | Repeat only ACT-0002 reassignment, inspect stored result, then continue deadline/completion and remaining Wire gates |
| 2026-09-16 | Wire formatted reassignment passed | Operator screenshot confirms ACT-0002 reassigned to Adam (Human) on `a51a7af`. Scoped DB inspection confirms qualified @adamhuman owner, version 2, open status, unchanged Friday deadline, and one reassignment audit event by Adam Low (two total events including creation). | Test deadline change and completion, then continue remaining Wire gates |
| 2026-09-17 | Wire deadline and completion passed | Operator screenshot confirms ACT-0002 deadline update and done acknowledgement. Scoped DB inspection verifies September 18 09:45:44.790 UTC, done status, version 4, retained @adamhuman owner and four audit events; both latest updates attributed to Adam Low. Core capture/list/reassign/deadline/complete action journey passes. Automated results above remain September 16 runs. | Test reminder creation and delivery next; unknown/ambiguous names and remaining Wire/human gates stay pending |
| 2026-09-17 | Reminder inline-code routing gap | Screenshot shows the pasted reminder command falling into Q&A; scoped DB query confirms no matching reminder exists. Earlier normalization covered ACT commands only. Twelve new routing/control cases fail before the fix; normalization now handles a leading single-line inline-code span before existing command matching, with prose/fence/multiline exclusions and real-mention privacy controls preserved. Build/type-check/lint and 248 tests pass; targeted real-model reminder create/list/snooze/cancel passes. | Inspect stored reminder/audits, run immutable-image full regression, update staging and repeat Wire creation/delivery |
| 2026-09-17 | Reminder formatting fix validated and staged | `f3b2eed`: 248 tests and build/type-check/lint pass; targeted stored reminder/audit inspection passes; immutable-image e2e 56/58 with the same two recorded discrepancies. Staging updated with readable backups and existing volumes; connected without SDK errors. | Repeat reminder creation and delivery on Wire; then cancellation, snooze and restart/downtime checks |
| 2026-09-17 | Wire reminder creation and delivery passed | Screenshot confirms REM-0001 delivered two minutes after creation on `f3b2eed`. Scoped DB verifies @adamhuman target, fired status, version 2, trigger 10:09:50.637 UTC and two audit entries; fired state saved at 10:09:50.755 UTC. Retry was plain text, so inline-code-specific Wire evidence is not claimed. | Test pending reminder recovery across restart, cancellation, snooze and overdue recovery |
| 2026-09-17 | Wire pending-reminder restart | Code-formatted creation of REM-0002 succeeds. Scoped DB shows pending, target @adamlow_wire, due 11:45:29.304 UTC. Same image restarted at 11:36:25.509 UTC with preserved volumes; startup rehydrated one reminder and reconnected without SDK errors. Record/due time unchanged after restart. | Confirm delivery and durable fired state after due time; overdue-during-downtime recovery remains separate |
| 2026-09-17 | Wire reminder delivery after restart passed | Operator screenshot confirms REM-0002 arrived at 12:45 UK time after the recorded restart. Scoped DB confirms fired status, version 2, original trigger, and two audit events including exactly one firing update; fired state saved 129 ms after due time. | Test cancellation, snooze and overdue-during-downtime recovery |
| 2026-09-17 | Cancellation/snooze prepared; combined-message gap observed | User screenshot shows two requests in one message falling into Q&A with misleading question guidance. Separate messages created REM-0003 and REM-0004; scoped DB confirms both pending, version 1, target @adamlow_wire, due 14:38:57.346 and 14:39:27.709 UTC. | Prioritise cancel/snooze as requested; return to bounded combined-command routing/guidance fix afterward |
| 2026-09-17 | Addressed assignment demo gap | Screenshot shows a named slide-deck assignment being treated as read-only Q&A; scoped DB confirms no slide/presentation action. Two routing cases reproduce the failure. A bounded @member-needs-to variant now calls the existing audited action use case, keeps the assignment deadline separate from preceding project context, and refuses questions/negation/hypotheticals/multiple assignments. Build/type-check/lint and 260 tests pass. REM-0003/4 had already fired; cancellation/snooze remain untested. | Validate stored assignment and full image regression, then retry the demo; keep combined-command and remaining Wire gates pending |
| 2026-09-17 | Named-assignment fix validated and staged | `17b8e42`: 260 tests, build/type-check/lint pass; targeted post-process inventory confirms one correctly owned/dated/audited action. Immutable-image e2e 56/59, new scenario passes; TC-ID-03 wording failure passes unchanged on single rerun and remains in full-run totals. Staging connected with preserved volumes, readable backups and zero SDK errors. | Retry the demo sentence; use fresh cancellation/snooze tests; combined-command and remaining acceptance gaps stay open |
| 2026-09-17 | Structured mention repair validated and staged | `ad01b3a`: 278 tests and build/type-check/lint pass. Immutable-image e2e 56/60; new demo and all action commands pass. Post-process DB confirms qualified owner, Friday deadline, one action/audit. Full run reveals a reproducible recorder/decider answer bug; preserved as an open gate. | Repeat the demo with the real person mention; fix attribution, review remaining failures and complete Wire/human gates |
| 2026-09-18 | Live mention, reminder mutations and overdue recovery | Operator reports tests 1–3 complete. Scoped records verify one correctly owned deck action and audited cancellation/snooze. REM-0007 remained pending past its deadline with the bot stopped, then sent successfully and became fired/version 2 with one firing audit after restart. Same image/volumes; zero startup SDK errors. | Confirm overdue reminder in Wire; observe cancelled reminder non-delivery and snoozed delivery at revised time; continue tests 5–8 and remaining code/human gates |
| 2026-09-18 | Wire decision correction lifecycle passed | Screenshot and qualified DB inspection verify supersede, current recall, revoke and no automatic revival; linked DEC-0003/4 states, versions and four audits match. Post-deadline reminder inspection also confirms cancelled REM-0005 has no firing audit and snoozed REM-0006 fired once at the revised time. | Continue passive capture/completion, channel isolation and privacy-state checks; confirm reminder UI receipt; retain separate attribution bug |
| 2026-09-18 | Silent Wire commitment captured | Post-processing DB/audit checks verify ACT-0005, qualified Adam Low owner/author, Friday deadline, exactly one action from the source and one creation audit. No acknowledgement was required or used as the score. | Test unmentioned completion as Adam Low and verify stored done status plus open-list removal |
| 2026-09-18 | Passive action reaction feedback implemented and staged | User-approved 📝/✅ post-write-and-audit reactions, combined outcomes, cancellation/dedup/failure tests and welcome explanation. `7384b39`: 296 tests/build/type-check/lint pass; real-model reaction lifecycle passes with stored-record/audit inspection. Fresh fixed sample 20/20/20, zero duplicates/markers, five capture reactions; simulation 57 events complete. Immutable-image e2e 57/60 with unchanged assertions; Friday judge discrepancies preserved, known attribution bug still visible despite passing verdict. Staging backed up and connected with zero SDK errors. | Verify 📝 and ✅ on new Wire messages; human review and other listed acceptance gates remain pending |
| 2026-09-18 | Wire reactions accepted; native replies implemented | Operator confirms 📝/✅; stored emoji checklist is done/version 2 with two audits. `4bc7e1f` quotes the exact source through SDK metadata and scopes/cleans it per handler; 304 tests/build/type-check/lint pass, immutable image built. | Staged with readable backups and zero SDK errors; operator screenshot verifies native quote and completed-action list removal. Full immutable-image regression 57/60, unchanged targeted author recheck passes; live two-message check pending |
| — | P3 pilot decision | Not started | Record usefulness, noise, latency and up to three next fixes |

The former v1/v2 plans, SDK migration plan and V3 gap list are superseded by this document.
Their historical text remains in Git. SDK operational cutover steps are retained in README;
there is no second active roadmap.
