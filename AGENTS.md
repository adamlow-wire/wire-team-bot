# AGENTS.md — AI agent guidance for Jeeves (Wire Team Bot) v3.0

This file is the primary contract for any AI agent working on this repository.
Read it before touching any code. When in doubt, ask rather than assume.

---

## 1. Authoritative plan

**Read `PLAN_v3.md` first.** It is the single source of truth for:
- Architecture decisions and rationale
- Component boundaries and responsibilities
- All resolved design decisions (§2)
- Phase-by-phase delivery checklist (§12)
- Security requirements (§8)
- Failure modes (§7)

Do not redefine architecture, module boundaries, or component roles without updating `PLAN_v3.md` first. If the plan conflicts with a requested change, flag it — do not silently deviate.

**Current delivery state**: v3.0 is in active development on `v3.0`. Phases are not yet started. v2.0 code is the current baseline.

---

## 2. Repository layout

```
src/
  app/              Composition root — wiring only, no business logic
    main.ts         Entry point
    container.ts    Dependency injection — wire all components here
    config.ts       All env var parsing; LLM slot configuration
    cli.ts          CLI harness for local testing (see §5)
  domain/           Pure business logic — no external dependencies
    entities/       Decision, Action, Reminder, Entity, SharedFile, etc.
    repositories/   Repository interfaces (ports)
    schemas/        Zod schemas — source of truth for types AND LLM output shapes
    services/       Domain service interfaces
  application/
    usecases/       One file per use case; depends only on domain + ports
    ports/          All external interface contracts (LLM, DB, Wire, file extraction)
  infrastructure/
    llm/            LLM adapters (Vercel AI SDK wrappers per slot)
    persistence/    Prisma repositories
    retrieval/      LlamaIndex retrieval engine
    pipeline/       BullMQ extraction pipeline (Tier 1→2→3)
    scheduling/     BullMQ cron + delayed jobs
    wire/           Wire SDK adapter + event router
    seed/           SeedLoader (startup only)
tests/
  usecases/         Unit tests — no DB, no LLM, fully mocked ports
  retrieval/        Unit tests for retrieval logic
  pipeline/         Unit tests for extraction pipeline
  contract/         Wire event routing contract tests
  integration/      Real Postgres (gated by INTEGRATION_TESTS=1)
  e2e/              LLM-as-judge end-to-end scenarios
prisma/
  schema.prisma     PostgreSQL schema
  migrations/       Migration history — never edit manually
```

---

## 3. Architecture rules

### 3.1 Layer dependency rules

| Layer | Location | Allowed to import |
|---|---|---|
| `domain` | `src/domain/` | Nothing outside domain |
| `application` | `src/application/` | `domain` only (via ports/interfaces) |
| `infrastructure` | `src/infrastructure/` | `application`, `domain`, external libs |
| `app` | `src/app/` | All layers — composition root only |

**Never**: import Wire SDK, Prisma, Vercel AI SDK, BullMQ, or any external library from `domain` or `application`. All external calls go through ports defined in `src/application/ports/`.

### 3.2 Where new code belongs

| What you're adding | Where |
|---|---|
| New entity or value object | `src/domain/entities/` |
| New repository contract | `src/domain/repositories/` |
| New Zod schema | `src/domain/schemas/` |
| New use case | `src/application/usecases/<feature>/` |
| New port (external interface) | `src/application/ports/` |
| New LLM adapter | `src/infrastructure/llm/` |
| New Prisma repository | `src/infrastructure/persistence/postgres/` |
| New retrieval component | `src/infrastructure/retrieval/` |
| Wiring | `src/app/container.ts` only |

### 3.3 Zod schemas are the type source of truth

All domain types are derived from Zod schemas in `src/domain/schemas/`. Use `z.infer<typeof Schema>` for TypeScript types. Do not define parallel TypeScript interfaces for things that have a Zod schema.

```ts
// Good
export const DecisionSchema = z.object({ summary: z.string(), ... })
export type Decision = z.infer<typeof DecisionSchema>

// Bad — duplicate type definition
interface Decision { summary: string; ... }
```

---

## 4. Processing pipeline (v3.0)

### 4.1 Background extraction pipeline (all channel messages)

Every message in an ACTIVE channel is enqueued as a BullMQ job:

```
Wire message received
  └─ BullMQ: enqueue to `extraction` queue
       jobId: `${channelId}:${messageId}`  ← deduplication key

BullMQ worker:
  Tier 1 — Classify (classify slot, generateObject + Zod)
    └─ is_high_signal: false → write ConversationSignal('discussion'), done
    └─ is_high_signal: true  → continue

  Tier 2 — Extract (extract slot, generateObject + Zod)
    └─ Check Redis `jeeves:created:<channelId>` flag
         flagged → skip decision/action writes (already created via tool call)
    └─ Write-time similarity check (≥0.85 cosine, 24h, serializable tx)
         match → merge; no match → insert
    └─ Upsert entities (≥0.92 similarity dedup)
    └─ Write ConversationSignal

  Tier 3 — Embed (embed slot, fire-and-forget child job)
    └─ Compute vector → store in embeddings table
    └─ Source text discarded immediately — never stored
```

**Critical invariants**:
- Job payloads contain `{ channelId, messageId, timestamp }` only — no message text
- Message text is read from the in-process SlidingWindowBuffer at job execution time
- Tier 3 runs as a BullMQ child job — fails independently, never blocks Tier 1/2

### 4.2 Intent classification and tool calling (@Jeeves messages)

Direct `@Jeeves` messages take a different path — they do not go through the background extraction pipeline:

```
@Jeeves message received
  └─ Operational fast-path regex check:
       matches pause|resume|secure → handle directly (no LLM call)

  └─ Intent classification (classify slot, generateObject + IntentSchema)
       clarificationNeeded: true → send clarifying question, wait for reply
       clarificationNeeded: false → route by intent type

  └─ Route by intent.type:
       question          → LlamaIndex retrieval → respond slot (generateText + tools)
       list_*            → Prisma structured query → format response
       log_decision /
       log_action /
       create_reminder   → execute tool directly; flag wire_msg_id in Redis
       correct_*/
       complete_*/
       reassign_*/etc.   → search tool → resolve entity → mutation tool
       unknown           → "I'm not sure what you'd like — could you rephrase?"
```

**Tool calling on the respond path**:
- `generateText({ tools, maxSteps: 5 })` — cap agentic loop at 5 steps
- All tools receive server-injected scope `{ channelId, orgId, requestingUserId }` — LLM cannot supply or override these
- All mutation tools write to `AuditLog` before returning
- Search tools return only records scoped to `channelId` + `orgId`
- Rate limit: 10 tool calls per turn, 30 mutations per user per hour (enforced in tool execution layer)

### 4.3 Scheduling (BullMQ cron)

```
BullMQ repeatable jobs:
  daily_summary_all    → cron: '0 8 * * *'      (08:00 UTC daily)
  weekly_summary_all   → cron: '0 8 * * 1'      (08:00 UTC Monday)
  staleness_check      → cron: '0 */6 * * *'    (every 6 hours)

BullMQ delayed jobs (per-reminder):
  reminder:<id>        → delay = triggerAt - now()
  On fire: send Wire message, reschedule if recurrent
```

---

## 5. Key component contracts

### 5.1 LLM slots (Vercel AI SDK)

All seven slots are configured in `src/app/config.ts` and wired in `container.ts`. Each is a `LanguageModelV1` instance from Vercel AI SDK using `createOpenAICompatible()`.

| Slot key | Env var | Purpose | Cost |
|---|---|---|---|
| `classify` | `JEEVES_MODEL_CLASSIFY` | Tier 1 signal detection + intent classification | Smallest model |
| `extract` | `JEEVES_MODEL_EXTRACT` | Tier 2 structured extraction | Medium model |
| `embed` | `JEEVES_MODEL_EMBED` | Tier 3 vector embedding | Embedding model |
| `summarise` | `JEEVES_MODEL_SUMMARISE` | Daily/weekly summaries | Medium model |
| `queryAnalyse` | `JEEVES_MODEL_QUERY_ANALYSE` | LlamaIndex router query analysis | Smallest model |
| `respond` | `JEEVES_MODEL_RESPOND` | Answer generation + tool calling | Largest model |
| `complexSynthesis` | `JEEVES_MODEL_COMPLEX` | Escalation for complex queries | Largest model |

**Usage pattern for all slots**:
```ts
// Structured output
const { object } = await generateObject({
  model: this.slots.classify,
  schema: IntentSchema,
  prompt: buildIntentPrompt(message, context),
})

// Tool calling (respond path only)
const { text } = await generateText({
  model: this.slots.respond,
  tools: buildChannelScopedTools(scope),
  maxSteps: 5,
  prompt: buildRespondPrompt(question, retrievedContext),
})
```

Token usage is emitted via `experimental_telemetry` as structured log entries — do not skip this.

### 5.2 mem0 (write path only)

mem0 is called exclusively from the write path — when a decision or action is created or updated. It is never called from the retrieval or respond path.

```ts
// On decision write — check for contradictions
const result = await mem0.add(
  [{ role: 'user', content: decision.summary }],
  {
    user_id: scope.channelId,
    metadata: {
      type: 'decision',
      orgId: scope.orgId,
      confidence: decision.confidence,
      standing: decision.standing ?? false,
    },
  }
)
// result.results contains any memories mem0 updated/superseded
// Use these to drive the contradiction resolution message
```

**Standing decisions** (`standing: true`) must be excluded from contradiction candidates. Pass `metadata.standing: true` and filter in the mem0 search before deciding to send a resolution message.

### 5.3 LlamaIndex (read path only)

LlamaIndex is called exclusively from the retrieval path — answering questions and resolving tool searches. It never writes to the DB.

```ts
const engine = RouterQueryEngine.fromDefaults({
  queryEngineTools: [structuredTool, semanticTool, graphTool, summaryTool],
  llm: slots.queryAnalyse,
})

// Post-retrieval re-ranking via @xenova/transformers cross-encoder
const reranker = new SentenceTransformerRerank({ model: 'cross-encoder/ms-marco-MiniLM-L-6-v2', topN: 10 })
```

All retrievers must apply `MetadataFilter({ channelId, orgId })` — scope is enforced at the retrieval layer.

### 5.4 BullMQ queues

Three queues, never mixed:

```ts
const extractionQueue = new Queue('extraction', { connection: redis })  // pipeline jobs
const scheduledQueue  = new Queue('scheduled',  { connection: redis })  // cron jobs
const reminderQueue   = new Queue('reminders',  { connection: redis })  // delayed reminders
```

Job payloads must never contain message text — only identifiers and timestamps.

---

## 6. Security rules (non-negotiable)

- **No raw message text in Redis.** Job payloads: `{ channelId, messageId, timestamp }` only.
- **No raw message text in DB.** Only `source_ref` (Wire message IDs + timestamp range), never the message content.
- **All tool calls have server-injected scope.** `channelId`, `orgId`, `requestingUserId` are injected by the tool execution layer. The LLM cannot supply or override these values.
- **Cross-channel mutation is always rejected.** Validate target record's `channelId` matches request scope before any mutation executes.
- **All mutation tools write to AuditLog.** Required fields: `tool`, `params` (scrubbed of PII beyond IDs), `requestingUserId`, `channelId`, `timestamp`, `outcome`.
- **Secrets come from `src/app/config.ts` only.** Never hardcode credentials, model names, or channel IDs.
- **Seed file is read-only.** Mount as `:ro` in docker-compose. Never write back to it.
- **Standing decisions are immune to background extraction.** Never auto-supersede a record where `standing: true`.
- **File content is never persisted.** `extractText()` returns a string that is used in-process and then garbage collected. Never write it to DB, Redis, or logs.

---

## 7. New features quick reference

### Organisation seed context

- Config: `JEEVES_SEED_FILE=/jeeves/seed.yaml` env var
- Loader: `src/infrastructure/seed/SeedLoader.ts`
- Called once at startup from `src/app/main.ts` before accepting Wire events
- Schema: `src/infrastructure/seed/seedSchema.ts` (Zod — validate YAML on load)
- Bad YAML schema → log clear error, abort startup. Missing file → skip silently.
- Seeded records: `source: 'seed'`, `standing: true` for standing decisions
- Idempotent: re-running with same file produces no DB changes

### File handling

- Wire file event → `AcknowledgeSharedFile` use case → store `SharedFile` metadata, send awareness message
- On-demand processing → `SummariseFile` or `ExtractFromFile` use case
- Port: `src/application/ports/FileExtractorPort.ts`
- Adapter: `src/infrastructure/files/FileExtractorAdapter.ts` (pdf-parse + mammoth)
- Extracted text: in-process only, discarded after use
- Committed extractions: `source: 'file:<filename>'` in Decision/Action

---

## 8. Testing

### 8.1 Unit tests

`npm test` — Vitest, no DB, no LLM, no network. All ports are mocked. Fast.

Required for: all use cases, all domain services, all non-trivial infrastructure adapters.

### 8.2 Integration tests

`INTEGRATION_TESTS=1 npm test` — real Postgres, real pgvecto.rs. No LLM.

Required for: Prisma repositories, retrieval engine, deduplication logic.

### 8.3 End-to-end tests (LLM-as-judge)

Full bot stack with real LLM calls. Each scenario has a natural-language `assert` evaluated by a judge model — no regexes.

```bash
npm run build && npm run test:e2e               # all scenarios
npm run test:e2e -- --filter TC-DEC             # by prefix
npm run test:e2e -- --filter TC-FILE-01         # single scenario
npm run test:e2e -- --bail                      # stop on first failure
npm run test:e2e -- --verbose                   # show full output for passing tests
npm run test:e2e -- --json                      # machine-readable results
```

Scenario IDs follow the pattern `TC-<FEATURE>-<NN>`. Add new scenarios for every new feature.

### 8.4 CLI harness (fast iteration)

The CLI harness drives the full bot stack from stdin/stdout. Use it to validate behaviour before running the full e2e suite.

```bash
npm run build && npm run cli
```

Seeded users: Alice (default), Bob, Carol, Dave. Prefix with `Name: ` to send as that user.

```bash
# Scripted — preferred for agents (stdout is clean, logs go to stderr)
printf "We've decided to use Postgres\n@jeeves what database are we using?\n" \
  | npm run cli

# With seed file
JEEVES_SEED_FILE=./jeeves-seed.yaml npm run build && npm run cli
```

**v3.0 validation checklist** — run these before marking any task complete:

| Scenario | Input | Expected |
|---|---|---|
| Implicit decision capture | Say a decision naturally (no prefix) | Acknowledgment message with Correct it / Dismiss |
| Natural action creation | "Can Mike handle the auth work?" | Action created for Mike, awareness message |
| Natural correction | "Actually that should be Sarah not Mike" | Action reassigned, echoes before/after |
| Natural completion | "That's done, we shipped yesterday" | Action completed with note |
| Question answered | State facts, then ask about them | Correct answer citing the facts |
| Standing decision not overwritten | Seed a decision, contradict it in chat | Seed decision unchanged; new decision captured separately |
| File awareness | Share a file | Metadata stored, awareness message, no extraction |
| File summarise | "Summarise that document" | Summary returned, no DB changes unless requested |
| File extract and commit | "Remember the decisions from that doc" | Decisions committed with `source: file:…` |
| Seed loaded | Start with `JEEVES_SEED_FILE` set | Seed facts retrievable immediately |

### 8.5 Agent self-fix loop

1. Run e2e suite: `npm run build && npm run test:e2e -- --bail`
2. On failure, runner prints: failing input, assertion, judge's reason, bot stdout
3. Iterate on the failing scenario: `npm run test:e2e -- --filter TC-<ID>`
4. Diagnose:

| Bot output | Likely cause | Where to look |
|---|---|---|
| `(empty)` | Intent classifier returned `unknown`, or use case threw | `WireEventRouter.ts`, use case `execute()` |
| Wrong entity | Tool search resolved wrong record | `search_decisions` / `search_actions` tool implementation |
| ID appears in response | Response formatter not using human-readable labels | Response adapter / answer prompt |
| Duplicate created | Dedup check not running, or Redis flag expired | `DecisionRepository.create()`, Redis TTL |
| Seed fact not found | SeedLoader didn't run or upsert failed | `SeedLoader.ts`, startup logs |
| File not processed | `FileExtractorPort` unsupported type or download failed | `FileExtractorAdapter.ts` |

5. After fix: verify single scenario, then run full suite.

**Debug flags**:
```bash
LOG_LEVEL=debug npm run cli          # full pipeline + retrieval trace on stderr
npm run test:e2e -- --verbose        # see raw bot output and judge reasoning side by side
npx prisma migrate reset --force     # completely clean DB if state is corrupted
```

---

## 9. Quick reference

| Topic | Reference |
|---|---|
| Full architecture + decisions | `PLAN_v3.md` |
| Layer dependency rules | §3.1 above |
| Processing pipeline | `PLAN_v3.md` §4; `src/infrastructure/pipeline/` |
| Intent classification | `PLAN_v3.md` §4.2; `src/infrastructure/wire/WireEventRouter.ts` |
| Tool calling + authorization | `PLAN_v3.md` §5.1; `src/infrastructure/llm/tools/` |
| LLM slots | `PLAN_v3.md` §5.1; `src/app/config.ts` |
| mem0 boundary | `PLAN_v3.md` §7 (Component Boundaries); write path only |
| LlamaIndex boundary | `PLAN_v3.md` §7; read path only |
| BullMQ queues | §4.3 above; `src/infrastructure/pipeline/`, `src/infrastructure/scheduling/` |
| Deduplication | `PLAN_v3.md` §4.1; 0.85 cosine (decisions/actions), 0.92 (entities) |
| Seed context | `PLAN_v3.md` §6.1; `src/infrastructure/seed/SeedLoader.ts` |
| File handling | `PLAN_v3.md` §6.2; `src/application/usecases/files/` |
| Security rules | `PLAN_v3.md` §9; §6 above |
| Failure modes | `PLAN_v3.md` §8 |
| Schema | `prisma/schema.prisma` |
| Env vars | `src/app/config.ts` |
| Persona rules | `PLAN_v3.md` §5.4 — no IDs in user-facing messages, no exclamation marks |
| Phase checklist | `PLAN_v3.md` §13 |

When in doubt: read `PLAN_v3.md`, match the existing codebase style, and ask before crossing architectural boundaries.
