# AGENTS.md – AI agent guidance for Wire Team Bot

This file gives AI agents working on this repository a concise contract: where the plan lives, how the app is structured, and how to keep the codebase maintainable, secure, and testable. **PLAN_v2.md** is the single source of truth for architecture, phases, and delivery state. This document summarises rules and desires for agent behaviour.

---

## 1. Authoritative plan

- **Read PLAN_v2.md first.** It defines:
  - Hexagonal architecture and dependency rules
  - Repository layout (`src/app`, `src/domain`, `src/application`, `src/infrastructure`, `tests/`)
  - Entities, ports, use cases, and phase-by-phase delivery
  - All resolved design decisions (ORM, queue, embedding dims, access scoping, etc.)
  - Current delivery state: **Phases 1a, 1b, 2, 3, and 4 are complete.** The bot is ready for end-to-end testing.
- Do not redefine architecture, module boundaries, or repo structure. If the plan is unclear or conflicts with a requested change, ask for PLAN_v2.md to be updated before implementing.

---

## 2. Application architecture

### 2.1 Layer rules

| Layer | Location | Allowed dependencies |
|---|---|---|
| `domain` | `src/domain/` | Nothing outside domain (no SDK, DB, LLM) |
| `application` | `src/application/` | `domain` + ports (interfaces only) |
| `infrastructure` | `src/infrastructure/` | `application`, `domain`, external libs |
| `app` | `src/app/` | All layers — composition root only, no business logic |

Application code must never call `wire-apps-js-sdk`, Prisma, or any LLM SDK directly. All external calls go through ports.

### 2.2 Four-tier processing pipeline

Every message received in an ACTIVE channel flows through an async pipeline:

```
Tier 1 (Classify) ─► OpenAIClassifierAdapter
                        └─ is_high_signal?
Tier 2 (Extract)  ─► OpenAIExtractionAdapter   (sliding window context)
                        ├─ DecisionRepository.create()
                        ├─ ActionRepository.create()
                        ├─ EntityRepository.upsertWithDedup()
                        ├─ ConversationSignalRepository.create()
                        └─ contradiction detection (similarity → classify)
Tier 3 (Embed)    ─► JeevesEmbeddingAdapter     (async, fire-and-forget)
                        └─ EmbeddingRepository.create()   (text discarded)
Tier 4 (Summarise)─► InProcessScheduler
                        ├─ daily_summary_all  at 08:00 UTC
                        └─ weekly_summary_all at Monday 08:00 UTC
```

Tiers 1–3 run through `InMemoryProcessingQueue` (max 5 concurrent, max depth 500). **Text content is never persisted** — only structured extractions and embedding vectors.

### 2.3 Multi-path retrieval engine

When the bot answers a question (`@Jeeves <question>`), it runs:

```
OpenAIQueryAnalysisAdapter  →  QueryPlan (intent, entities, timeRange, paths, complexity)
        │
        ▼
MultiPathRetrievalEngine (Promise.allSettled)
  ├─ StructuredRetrievalPath   SQL: decisions/actions by filter
  ├─ SemanticRetrievalPath     pgvector HNSW on embeddings table
  ├─ GraphRetrievalPath        BFS on entity_relationships (depth ≤ 3)
  └─ SummaryRetrievalPath      cached channel summaries
        │
        ▼
  Weighted RRF merge: score = Σ(1/(60+rank)) × multi-path-boost × recency × confidence
  Multi-path boost: 1.5× when result found by ≥2 paths
  Token budget: 7,000 tokens cap
        │
        ▼
OpenAIGeneralAnswerAdapter  →  Jeeves-voice response (respond / complexSynthesis slot)
```

Intent `temporal_context` and `institutional` auto-inject the `SummaryRetrievalPath` even when not explicitly in the plan.

### 2.4 Seven LLM model slots

All slots share one `JEEVES_LLM_BASE_URL` / `JEEVES_LLM_API_KEY`. Configured via `JEEVES_MODEL_*` / `JEEVES_FALLBACK_*` env vars. See PLAN_v2.md §5.9 and `src/app/config.ts`.

| Slot | Env var | Default model |
|---|---|---|
| `classify` | `JEEVES_MODEL_CLASSIFY` | `qwen3-2507:4b` |
| `extract` | `JEEVES_MODEL_EXTRACT` | `qwen3-2507:30b-a3b` |
| `embed` | `JEEVES_MODEL_EMBED` | `qwen3-embedding:4b` |
| `summarise` | `JEEVES_MODEL_SUMMARISE` | `qwen3-2507:30b-a3b` |
| `queryAnalyse` | `JEEVES_MODEL_QUERY_ANALYSE` | `granite4-tiny-h:7b` |
| `respond` | `JEEVES_MODEL_RESPOND` | `qwen3-2507:30b-a3b` |
| `complexSynthesis` | `JEEVES_MODEL_COMPLEX` | `qwen3-next:80b` |

**`LLM_PASSIVE_*` / `LLM_CAPABLE_*`** are **not** deprecated. They power `OpenAIConversationIntelligenceAdapter`, which is the v1 foreground intent router still active for explicit commands (`create_decision`, `create_action`, `create_reminder`, etc.). They will be retired when v1 routing is fully replaced by the v2 pipeline.

### 2.5 Channel state machine

Channels have three states: `ACTIVE` | `PAUSED` | `SECURE`. State is persisted in `channel_config`. SECURE flushes the sliding window buffer and records a `secure_range` timestamp to prevent context contamination.

### 2.6 Access scoping

Retrieval is always scoped to the requesting channel. `MultiPathRetrievalEngine` returns `[]` if `scope.channelId` is absent. In personal mode (1:1 DM — one non-bot member), `RetrievalScope.userId` is set, enabling org-wide queries filtered to the user's own entities.

### 2.7 Where new code belongs

- New entity or repository contract → `src/domain/`
- New use case → `src/application/usecases/`
- New port → `src/application/ports/` (interface only)
- New infrastructure adapter → `src/infrastructure/`
- Wiring → `src/app/container.ts`

---

## 3. Maintainability

- Prefer **small, reviewable changes** that are easy to test and reason about.
- **One concern per module:** Keep use cases focused.
- **Explicit over implicit:** Prefer clear parameters and return types.
- **Consistency:** Match existing naming, file layout, and style (TypeScript/ESLint).
- Do not introduce new dependencies unless PLAN_v2.md or the user explicitly requests them.
- **Extract-and-forget:** Never persist raw message text. Only structured extractions (`decisions`, `actions`, `entities`, `signals`) and embedding vectors are stored.

---

## 4. Security

- **Secrets:** All secrets come from environment variables via `src/app/config.ts`. Never hardcoded.
- **Audit trail:** Actions that create/update/delete domain entities must be recorded via `AuditLogRepository`.
- **Input validation:** Treat LLM outputs as untrusted. Validate structure and bounds before persistence.
- **Access scoping:** Retrieval must never cross channel boundaries. Cross-channel retrieval is post-MVP.
- **Embedding dims:** Confirm `JEEVES_EMBED_DIMS` matches your embedding model's output before migrating. Mismatch is caught at startup (logged, embedding disabled, bot continues).

---

## 5. Testability

- **Unit tests (`tests/usecases/`, `tests/retrieval/`, `tests/pipeline/`):** No SDK, DB, or network. Fully mocked ports.
- **Contract tests (`tests/contract/WireEventRouter.contract.test.ts`):** Verify routing from Wire SDK events to use-case calls.
- **Integration tests (`tests/integration/`):** Real Postgres with pgvector. Gated by env (`INTEGRATION_TESTS=1`).
- **Run:** `npm test` (Vitest). **Type-check:** `npx tsc --noEmit`.
- All new use cases and non-trivial logic must have corresponding tests. Match existing test structure.

### 5.1 CLI harness — end-to-end validation without Wire client

`src/app/cli.ts` drives the full bot stack (real DB, real LLM calls, real pipeline) from stdin/stdout. Use it to validate behaviour end-to-end before claiming a feature works.

**Always build first:** `npm run build && npm run cli`

**Seeded members:** Alice (default), Bob, Carol — prefix a line with `Name: ` to send as that user.

**Interactive:**
```
npm run build && npm run cli
> decision: we will use Postgres
[Jeeves] Decision logged — DEC-0001 ...
> @jeeves what decisions have we made?
[Jeeves] One decision on record ...
```

**Scripted (preferred for agents — stdout is clean, logs go to stderr):**
```bash
printf "decision: we will use Postgres\nBob: action: Alice to write the migration\n@jeeves what actions are open?\n" \
  | npm run cli
```

**Agent validation checklist — run these before marking a task done:**

| Scenario | Input | Expected output contains |
|---|---|---|
| Log a decision | `decision: <summary>` | `DEC-` reference |
| Log an action | `action: <description>` | `ACT-` reference |
| Assign action | `action: <desc> for Bob` | Bob's name in confirmation |
| Search decisions | `decisions about <topic>` | matching decision or "no record" |
| Remind | `remind me tomorrow to <desc>` | confirmation with time |
| Answer from context | say facts, then `@jeeves <question about those facts>` | answer drawn from recent conversation |
| Follow-up | `@jeeves <question>`, then `@jeeves yes` / `go ahead` | coherent follow-up, not "no record" |
| Unknown command | `@jeeves <open question>` | non-empty answer, no crash |

**E2E test suite — LLM-as-judge (preferred for agent validation):**

Scenarios use natural language inputs. Each assertion is plain English, evaluated by the LLM judge (`tests/e2e/judge.ts`) rather than regex. The judge uses `JEEVES_JUDGE_MODEL` (falls back to `JEEVES_MODEL_CLASSIFY`).

```bash
npm run build && npm run test:e2e                              # run all scenarios
npm run build && npx tsx tests/e2e/runner.ts --filter TC-DEC  # decisions only
npx tsx tests/e2e/runner.ts --verbose                         # show bot output + judge reasoning
```

To add a scenario, add an entry to `tests/e2e/scenarios.ts` with natural language `input` and a plain-English `assert` string — no regexes needed.

Multi-step scenarios use `captureAs: "DEC"|"ACT"|"REM"` to extract reference IDs, then `{{DEC}}`/`{{ACT}}`/`{{REM}}` in subsequent inputs to inject them.

**Tips:**
- Set `LOG_LEVEL=debug` to see pipeline and retrieval trace output on stderr: `LOG_LEVEL=debug npm run cli`
- The CLI uses a fixed channel `cli-channel@cli.local` — data persists across runs in your local DB
- If the DB is stale from a previous test run, `npx prisma migrate reset --force && npm run build` gives a clean slate

---

## 6. Quick reference

| Topic | Reference |
|---|---|
| Architecture + phases | PLAN_v2.md |
| Dependency rules | §2.1 above; domain → nothing, application → domain + ports, infra → both |
| Processing pipeline | PLAN_v2.md §5.4; `src/infrastructure/pipeline/ProcessingPipeline.ts` |
| Retrieval engine | PLAN_v2.md §10; `src/infrastructure/retrieval/MultiPathRetrievalEngine.ts` |
| LLM slots | PLAN_v2.md §5.9; `src/app/config.ts` `JeevesLLMConfig` |
| Channel state machine | PLAN_v2.md §5.1; `src/domain/repositories/ChannelConfigRepository.ts` |
| Summary scheduling | `src/app/container.ts` `daily_summary_all` / `weekly_summary_all` jobs |
| Env vars | PLAN_v2.md §7; `src/app/config.ts` |
| Schema | PLAN_v2.md §6; `prisma/schema.prisma` |
| Persona rules | PLAN_v2.md §11 — no exclamation marks, "I'm afraid" not "Sorry" |
| Post-MVP items | Cross-channel retrieval, Redis/BullMQ, Drizzle ORM, v1 routing retirement |

When in doubt, align with PLAN_v2.md and the existing codebase. If a change would cross architectural boundaries or contradict the plan, flag it before proceeding.
