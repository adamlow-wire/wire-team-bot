# v3 — Feature and Experience Gaps

> Working document for the new `v3` branch. The old `v3.0` branch is obsolete as code; this page
> mines it, together with the fix history on `main`, the e2e scenarios and the staging run of
> 2026-09-16, for the *problems* that drove it. Every gap is stated as something a team member
> experiences, then mapped to `GOALS.md`. Dispositions are proposals for markup, not decisions.

**Evidence keys.** `plan` = old `PLAN_v3.md`; `fix:` = a commit on `main` from March 2026 that
patched the symptom; `TC-…` = an e2e scenario that encodes the current behaviour; `staging` =
observed 2026-09-16; `diag` = the old branch's own diagnostic table of failures seen while building.

**Disposition legend.** *Adopt idea* = rebuild on `v3`, design first. *Adopt code* = the old branch
has a self-contained implementation worth cherry-picking after review. *Rethink* = real problem,
proposed solution too heavy for the evidence. *Done* = already on `main`. *Partial* = mitigated on
`main`, not solved.

## A. Talking to the bot (principle 2: natural language is the interface)

| # | Gap as experienced | Evidence | Old v3.0 built | On `main` today | Disposition |
|---|---|---|---|---|---|
| A1 | You have to learn a syntax: `decision:`, `action:`, `remind me … to …`, exact list phrases. Natural variants fall through to Q&A or are ignored. | `fix: broaden natural-language patterns`, `fix: broaden remind regex`, `fix: accept 'safe mode' alias`, `fix: strip @mention prefix`; plan §4.2 | Intent classifier (Zod discriminated union, 17 intents) + intent-to-use-case executor; regex kept only for pause/resume/secure | Regex cascade, ~20 patterns | **Adopt idea.** Central to principle 2. Classifier latency and local-model accuracy must be measured first (plan OQ4). |
| A2 | The bot answers with internal IDs (`DEC-0001`, `ACT-0001`) and expects them back for corrections. | `TC-DEC-01 "gets a DEC reference back"`, `TC-ACT-05 "ACT-0001 done"`; plan §5.4 | No IDs in any user-facing message; pending-action store for button state | IDs in every confirmation and list | **Adopt idea.** IDs stay internal for audit and dedup. |
| A3 | Ambiguity is an error, not a question ("which Sarah?"). | plan §4.2, §5.1 | Clarifying question when a search returns several matches | Hard error / wrong assignee | **Adopt idea.** |
| A4 | Robotic or evasive replies: asks permission instead of acting, hollow openers, "no record" when you were creating something, invented actions when the DB is empty. | `fix(ux): eliminate permission-asking responses`, `fix(qa): narrow rule-3`, `fix(llm): prevent hallucinated actions`, `TC-PERSONA-*` | Nothing specific beyond prompt rework | Patched by prompt rules; fragile across models | **Partial.** Belongs to the provider-neutral prompt and eval work, not a feature. |
| A5 | Follow-ups without re-mentioning the bot only work when its last message ended with a question mark. | `TC-QA-05`, `fix(ux): handle follow-ups`; GOALS open question | Not addressed | Heuristic | **Rethink.** Decide the group-channel addressing rule in `GOALS.md` first. |

## B. Capture (principle 1; "rely on: Capture")

| # | Gap as experienced | Evidence | Old v3.0 built | On `main` today | Disposition |
|---|---|---|---|---|---|
| B1 | The same decision or action gets recorded two or three times: once from the explicit statement, again from the background pipeline, again as the sliding window moves. | `fix: skip enqueue for explicit commands`, `fix: pass known open actions to extractor`, `TC-PIPE-06/07`; plan §4.1; `diag: Duplicate created` | Three-layer write-time dedup: creation flag (Redis), content-hash unique index, embedding similarity ≥0.85 within 24h; two migrations; 26 tests | Two point mitigations | **Adopt code** (dedup service, hash index, migrations) after review; the Redis flag layer depends on the queue decision (D4). |
| B2 | High-signal messages silently vanish when the model returns malformed or truncated JSON. | `fix(extractor): max_tokens 600→1500 to prevent JSON truncation`, `fix(llm): strip think blocks`, `.env.example` note on thinking models returning empty JSON; plan decision 1 | Zod schemas + `generateObject` with validation retry for all five adapters | Manual `JSON.parse` with fence stripping | **Adopt idea, likely adopt code.** Also the right answer for Claude, whose compatibility layer ignores JSON mode. Provider-neutral by construction. |
| B3 | People appear as UUIDs, or attribution is missing right after a restart. | six `fix(identity/display/cache/attribution)` commits on 2026-03-26 | Not addressed | Mitigated: profile lookup, cache hydration on start, 24h refresh | **Partial.** Re-verify on the new SDK (hydration path changed); add a scenario. |
| B4 | Commitments made in passing ("she'll handle it", "we shipped it yesterday") are captured inconsistently. | `TC-PIPE-03/05`, `feat(ports): KnownAction, ExtractedCompletion`; plan checklist "natural completion" | Completion via intent path | Window-based extraction, completions port added late | **Partial.** Needs a measured baseline (D6) before more prompt work. |
| B5 | The bot starts blind: no idea who the people are, what the standing decisions are, or what the team's terms mean. Weeks of listening before it is useful. | plan §6.1 ("starts blind") | `SeedLoader` from `jeeves-seed.yaml`: people, standing decisions, terminology; `source`/`standing` fields | Nothing | **Adopt code** after review. Small, self-contained, directly serves "rely on: Capture". |
| B6 | Files shared in the channel are invisible to the bot even when they contain the decisions. | plan §6.2 | Designed (lazy: metadata on share, process on request), not built | Nothing; asset messages ignored | **Adopt idea, later.** Depends on the SDK's asset download, which the new SDK exposes. |

## C. Recall ("rely on: Recall")

| # | Gap as experienced | Evidence | Old v3.0 built | On `main` today | Disposition |
|---|---|---|---|---|---|
| C1 | Questions miss things that are in the database: entity keyword filters produced false negatives, the planner omitted the structured path, relevant results were cut by the token budget. | `fix: drop entity text filter`, `fix: always inject structured path`; plan phase 4 rationale ("silent truncation") | LlamaIndex fusion retriever + cross-encoder reranker (designed, not built) | Heuristic patches | **Rethink.** The three fixes on `main` already address the observed cases. Measure recall on real questions before adding a retrieval framework and a local model. |
| C2 | When the bot has nothing, it says so opaquely. | plan phase 4 ("I don't have this because…") | Designed, not built | Generic "no record" | **Adopt idea.** Cheap: pass retrieval metadata into the answer prompt. |
| C3 | Semantic recall depends on an embedding provider the deployment may not have. | `staging` (Claude has no embeddings) | Not addressed | Explicit on/off with one startup warning (2026-09-16) | **Done** for graceful degradation; capability gap remains for Claude-only deployments (Voyage or local Ollama). |

## D. Progress and administration ("rely on: Progress") — the thinnest area today

| # | Gap as experienced | Evidence | Old v3.0 built | On `main` today | Disposition |
|---|---|---|---|---|---|
| D1 | Correcting the record needs an ID and a command (`ACT-0001 reassign to @bob`). "Actually that was Sarah's" does nothing. | plan §5.5; `TC-ACT-06` | Correction intents routed to use cases; before/after echo designed | Command only | **Adopt idea.** Falls out of A1 + A2. |
| D2 | When a new decision contradicts an old one the bot asks "Shall I mark it superseded?" and nothing happens when you answer. | plan §5.3 | Declarative resolution ("I've updated…") with an Undo button and a 5-minute window; `PendingActionStore` | Unanswered question | **Adopt idea**, rebuild without mem0. The existing contradiction detector is adequate; the missing part is the resolution UX. |
| D3 | Passive capture is invisible: the bot records things and you only find out later. No way to confirm or dismiss. | plan §5.2; `diag`; `staging` button UI issue (#7); plan phase 5 "dead 'Any actions from this?' button" | Acknowledgement with Correct / Dismiss buttons; `dismissedAt` | A composite prompt that does nothing useful | **Adopt idea**, blocked on #7 (button confirmation not reflected in clients). Fix #7 first or the whole correction UX is dead on arrival. |
| D4 | Reminders and scheduled jobs live in process memory; a restart at the wrong moment loses them. | `fix(reliability): isolate scheduler job failures and guard reminder rehydration`; plan decision 2 | BullMQ queues and delayed jobs on Redis | Rehydration from Postgres on start; in-process timers | **Rethink.** Reminders are already persisted and rehydrated. Decide whether Redis is worth adding to an air-gapped footprint, or whether a Postgres-backed job table gives the same durability with no new service. |
| D5 | No view of what moved: no weekly "what changed, what's stuck", no progress tracking of an action over time. | GOALS "Progress" section; `CheckStaleness` nudges exist | Not addressed | Daily/weekly summaries exist but are conversation summaries, not progress | **New.** Not in the old plan at all; the goals page asks for it. |
| D6 | Nobody can say whether capture quality is good: the simulation baseline (`golden.json`) is an empty placeholder and there is no token or cost visibility. | `golden.json` `_readme` only; plan phase 1 "instrument per-slot token usage"; plan OQ5 | Token telemetry designed | Simulation harness exists, never baselined | **Adopt idea, first.** Every other disposition marked "measure" depends on this. |

## E. Control and operation

| # | Gap | Evidence | Old v3.0 built | On `main` | Disposition |
|---|---|---|---|---|---|
| E1 | Bot name hardcoded. | GOALS principle 3 | `BOT_NAME` | PR #8 | **Done** pending merge. |
| E2 | Voice is fixed (British butler). | plan §6.3 note | `BOT_SYSTEM_PROMPT_SUFFIX` mentioned as future | Fixed | **Later.** Only if a second team wants a different voice. |
| E3 | Deployment footprint: the old branch adds Redis and swaps the Postgres image to pgvecto.rs. | plan decisions 2 and 6 | Compose changes | pgvector, no Redis | **Rethink.** Each new service is a cost in an air-gapped deployment; pgvecto.rs solves a performance problem nobody has measured. |

## What the old branch got right, and what to leave

Worth carrying forward, as ideas or as code: schema-validated model output (B2), write-time
deduplication (B1), the seed file (B5), no IDs in conversation (A2), natural-language intents (A1),
declarative contradiction handling with undo (D2), the acknowledgement loop (D3), `BOT_NAME` (E1).

Leave behind unless evidence appears: mem0 as a second store, LlamaIndex and a local reranker,
pgvecto.rs, and Redis as a hard dependency (D4, E3). Each adds an operational surface to an
air-gapped box for a problem `main` has either patched or never measured.

Missing from the old plan entirely: a progress view (D5) and a measured quality baseline (D6).

## Proposed order for `v3`

1. **D6** measured baseline, so every later change is judged, not felt.
2. **#7** button confirmation, because D2 and D3 depend on buttons working.
3. **B2** schema-validated output, provider-neutral, unblocks reliable A1.
4. **A1 + A2 + D1** natural-language addressing and corrections, no IDs.
5. **B1 + B5** deduplication and seed context, largely by adopting reviewed code.
6. **D2 + D3** contradiction resolution and acknowledgements.
7. **D5** progress view. **C2** transparent "nothing found". **B6** files, later.

## Questions for markup

- A5 / GOALS open question: in a group, is an untagged message ever addressed to the bot?
- D4 / E3: is Redis acceptable in the air-gapped footprint, or should durability stay in Postgres?
- B5: who owns the seed file operationally, and is YAML in a mounted volume the right shape?
- D5: what does a useful weekly progress view look like for your team, concretely?
