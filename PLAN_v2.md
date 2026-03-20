# Jeeves v2.0 — Implementation Plan

> Branch: `v2.0`
> Based on: MVP Architecture v2.0 specification
> Current baseline: all v1 tests passing (63 pass, 7 skip), committed and pushed on `main`

---

## 1. Executive Summary

v2.0 is a fundamental architectural shift, not a feature addition. The core principle is
**extract-and-forget**: raw message text is processed immediately for structured knowledge, then
discarded. Nothing goes to an AI service unless the bot has explicit permission, and nothing
persists that cannot be justified as durable team knowledge.

The processing model moves from a single-pass intent classifier to a **four-tier pipeline**
that separates fast classification from deep extraction, embedding, and scheduled summarisation.
Retrieval moves from keyword + semantic search to a **multi-path engine** that combines structured
SQL, pgvector similarity, entity-graph traversal, and rolling conversation summaries.

---

## 2. What is Preserved from v1

| Component | Status | Notes |
|---|---|---|
| Hexagonal architecture (ports/adapters) | Keep | Clean layering is good; domain stays stable |
| `Task`, `Action`, `Decision`, `Reminder` domain entities | Keep with changes | Remove `rawMessage` fields |
| `KnowledgeEntry` | Restructure | Merge into new `entities` model; keep `embedding` column |
| Prisma + PostgreSQL + pgvector | Keep | Add new tables via migration |
| `WireEventRouter` | Heavily refactor | Split into pipeline stages |
| `OpenAIEmbeddingAdapter` | Keep | Wire to new `embed` model slot |
| `InProcessScheduler` | Keep | Add new job types |
| `PendingActionBuffer` | Keep | Already implements the maturity delay |
| `ConversationMessageBuffer` | Keep | Feeds into conversation signals |
| `InMemoryMemberCache` | Keep | Still needed for member injection |
| `WireOutboundAdapter` | Keep | No changes needed |
| All existing use-case classes | Keep, adapt | Some gain/lose constructor args |
| Contract test suite | Extend | Do not break existing tests |

---

## 3. What Changes Fundamentally

### 3.1 Extract-and-Forget

**Every** `rawMessage` field is removed from the DB schema. Currently stored in:
- `Task.rawMessage` / `Task.rawMessageId`
- `Action.rawMessage` / `Action.rawMessageId`
- `Decision.rawMessage` / `Decision.rawMessageId`
- `KnowledgeEntry.rawMessage` / `KnowledgeEntry.rawMessageId`
- `Reminder.rawMessage` / `Reminder.rawMessageId`

These fields are replaced by a per-message processing pipeline that extracts structured data
first, then drops the text. The `rawMessageId` (Wire message ID) is retained as a reference key
for threading/reactions but the content string is not stored.

**Migration strategy**: new nullable columns first → populate from extraction → drop old columns.
The existing data will lose `rawMessage` content (acceptable — this is a dev/MVP app).

### 3.2 Processing Pipeline (Four Tiers)

```
Every message
    │
    ▼
Tier 1: Classify  ──── fast model (classify) ────►  intent + signal score
    │
    ├─ low signal ──────────────────────────────►  tick ConversationSignal only
    │
    └─ high signal
           │
           ▼
       Tier 2: Extract  ─── deep model (extract) ──►  structured entities
           │
           ├─► Task / Action / Decision / KnowledgeEntry (no raw text)
           └─► entity_relationships upserted
                   │
                   ▼
               Tier 3: Embed  ─── embedding model ──►  pgvector column updated
                   │
                   ▼
               Scheduled:
               Tier 4: Summarise ─── summarise model ─►  summaries table
```

Current architecture has Tier 1 + Tier 3 (embedding runs async on KnowledgeEntry only).
v2.0 adds Tier 2 (deep extract) and Tier 4 (scheduled summarisation) and extends Tier 3 to all
embeddable entities.

### 3.3 Seven LLM Model Slots

| Slot | Env Var | Purpose | Current equivalent |
|---|---|---|---|
| `classify` | `LLM_CLASSIFY_*` | Tier 1: every message, fast | `passiveLlm` |
| `extract` | `LLM_EXTRACT_*` | Tier 2: deep extraction | `capableLlm` (implicit) |
| `embed` | `LLM_EMBED_*` | pgvector embeddings | `embeddingConfig` |
| `summarise` | `LLM_SUMMARISE_*` | Rolling summaries | new |
| `queryAnalyse` | `LLM_QUERY_ANALYSE_*` | Query decomposition before retrieval | new |
| `respond` | `LLM_RESPOND_*` | Final Jeeves response | `capableLlm` |
| `complexSynthesis` | `LLM_COMPLEX_*` | Multi-source synthesis | new (optional) |

Each slot has `baseUrl`, `apiKey`, `model`, `enabled` config. Slots fall back: if a slot is
disabled, it uses the next capable slot up. `complexSynthesis` defaults to `respond`.

### 3.4 Channel Context (Enriched)

`ConversationConfig.raw` currently holds an unstructured JSON blob with `purpose`. This is
replaced by a proper set of columns:

```
contextType:    enum(general | project | incident | decision | standup | customer)
purpose:        string (existing, promoted)
tags:           string[]
stakeholders:   string[] (Wire user IDs)
relatedChannels: string[] (conversation IDs)
```

New commands:
- `@Jeeves context: <description>` — set/update purpose
- `@Jeeves context type: project` — set type
- `@Jeeves context tags: alpha, mobile` — set tags
- `@Jeeves context stakeholders: @alice @bob` — set stakeholders
- `@Jeeves status` — Jeeves reports channel context + recent activity

### 3.5 Entity Graph

Two new tables: `Entity` and `EntityRelationship`.

`Entity` is a superset of the current `KnowledgeEntry` — it represents any durable piece of
team knowledge: tasks, actions, decisions, raw facts, people, projects. Typed by `entityType`.

`EntityRelationship` stores typed directed edges:
- `owns` — person owns a task/action
- `depends_on` — task depends on another
- `works_on` — person works on a project
- `blocks` — entity blocks another
- `reports_to` — org hierarchy

The entity graph feeds the **graph traversal retrieval path**: given a starting entity, the
retrieval engine can walk relationships to return contextually related facts.

### 3.6 Rolling Summaries + "Catch Me Up"

New `ConversationSummary` table with `granularity` (hourly/daily/weekly) and `content`.
Scheduled jobs generate summaries from `ConversationSignal` records using the `summarise` model.

New commands:
- `@Jeeves catch me up` / `@Jeeves what did I miss` — returns the most recent summary
- Summaries are injected into LLM context automatically for better temporal awareness

### 3.7 Multi-Path Retrieval

The current `PrismaSearchAdapter` (keyword + semantic RRF) becomes one path inside a
`MultiPathRetrievalEngine`:

```
Query
  │
  ├─ Path 1: Structured SQL  (tasks/actions/decisions filtered by status/date/assignee)
  ├─ Path 2: Semantic pgvector  (existing HNSW + RRF hybrid)
  ├─ Path 3: Entity graph  (BFS from named entities in the query)
  └─ Path 4: Summary  (inject relevant rolling summary if temporal question)
       │
       ▼
  RRF merge → top-k results → inject into LLM prompt
```

### 3.8 Decision Contradiction Detection

After each new decision is logged, run a semantic similarity check against recent decisions in
the same conversation. If cosine similarity > 0.85, flag to the user:
> "I notice this may contradict decision DEC-0003 from 12 March. Shall I mark it superseded?"

---

## 4. Database Schema Changes

### 4.1 New Tables

```sql
-- Lightweight signal per message (replaces rawMessage storage)
CREATE TABLE conversation_signals (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  conversation_dom TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  author_dom      TEXT NOT NULL,
  signal_type     TEXT NOT NULL, -- 'task_mention','decision','action','question','general'
  confidence      REAL NOT NULL,
  timestamp       TIMESTAMP NOT NULL,
  processed       BOOLEAN DEFAULT FALSE
);

-- Entity graph nodes
CREATE TABLE entities (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  conversation_dom TEXT NOT NULL,
  entity_type     TEXT NOT NULL, -- 'task','action','decision','fact','person','project'
  label           TEXT NOT NULL, -- human-readable short name
  summary         TEXT NOT NULL,
  detail          TEXT,
  category        TEXT,
  confidence      TEXT,
  tags            TEXT[],
  ttl_days        INT,
  embedding       vector(1024),
  created_at      TIMESTAMP NOT NULL,
  updated_at      TIMESTAMP NOT NULL,
  deleted         BOOLEAN DEFAULT FALSE
);

-- Entity graph edges
CREATE TABLE entity_relationships (
  id              TEXT PRIMARY KEY,
  from_entity_id  TEXT NOT NULL REFERENCES entities(id),
  to_entity_id    TEXT NOT NULL REFERENCES entities(id),
  relation_type   TEXT NOT NULL, -- 'owns','depends_on','works_on','blocks','reports_to'
  weight          REAL DEFAULT 1.0,
  created_at      TIMESTAMP NOT NULL
);

-- Rolling conversation summaries
CREATE TABLE conversation_summaries (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  conversation_dom TEXT NOT NULL,
  granularity     TEXT NOT NULL, -- 'hourly','daily','weekly'
  period_start    TIMESTAMP NOT NULL,
  period_end      TIMESTAMP NOT NULL,
  content         TEXT NOT NULL,
  created_at      TIMESTAMP NOT NULL
);
```

### 4.2 Modified Tables

**All entity tables** (`Task`, `Action`, `Decision`, `KnowledgeEntry`, `Reminder`):
- Remove: `rawMessage TEXT`, `rawMessage TEXT`
- Keep: `rawMessageId TEXT` (Wire message ID for threading)

**`ConversationConfig`**:
- Add: `contextType TEXT`, `tags TEXT[]`, `stakeholders TEXT[]`, `relatedChannels TEXT[]`
- Keep: `purpose` (currently in `raw` blob — promote to first-class column)
- Remove: `raw JSON` (after migrating existing purpose values)

### 4.3 Migration Order

1. Add new tables (`conversation_signals`, `entities`, `entity_relationships`, `conversation_summaries`)
2. Add nullable columns to `ConversationConfig` (contextType, tags, stakeholders, relatedChannels, purpose as column)
3. Migrate `raw.purpose` → `purpose` column for existing rows
4. Add `rawMessage` nullable columns to entity tables (prepare for removal)
5. Drop `rawMessage` content columns after extraction pipeline is live
6. Add HNSW index on `entities.embedding`

---

## 5. New/Changed Application Ports

### New Ports

```typescript
// application/ports/ClassifierPort.ts
export interface ClassifierPort {
  classify(text: string, context: string[]): Promise<ClassifyResult>;
}
export interface ClassifyResult {
  intent: string;           // classify intent
  signalScore: number;      // 0–1, how information-rich
  captureHints: string[];   // what to extract in Tier 2
}

// application/ports/ExtractionPort.ts
export interface ExtractionPort {
  extract(text: string, hints: string[], context: string[]): Promise<ExtractResult>;
}
export interface ExtractResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

// application/ports/SummarisationPort.ts
export interface SummarisationPort {
  summarise(signals: ConversationSignal[], granularity: 'hourly'|'daily'|'weekly'): Promise<string>;
}

// application/ports/QueryAnalysisPort.ts
export interface QueryAnalysisPort {
  analyse(query: string, context: string[]): Promise<QueryPlan>;
}
export interface QueryPlan {
  paths: Array<'structured'|'semantic'|'graph'|'summary'>;
  filters: Record<string, unknown>;
  expansions: string[];  // entity names to graph-traverse from
}

// application/ports/RetrievalPort.ts
export interface RetrievalPort {
  retrieve(plan: QueryPlan, conversationId: QualifiedId): Promise<RetrievalResult[]>;
}
```

### Modified Ports

**`GeneralAnswerPort`** — add `RetrievalResult[]` replacing `KnowledgeContext[]`:
```typescript
answer(question, context, retrieval, members?, purpose?, contextType?): Promise<string>
```

**`ConversationIntelligenceService`** — renamed to `ClassifierPort` (same contract, new name).
The existing `ImplicitDetectionService` is merged into the Tier 2 extraction flow.

---

## 6. LLM Configuration

### `LLMConfigAdapter.ts` — Extend

Add seven `get*LLMConfig()` functions:
```typescript
getClassifyLLMConfig(config)    // was getPassiveLLMConfig
getExtractLLMConfig(config)     // was getCapableLLMConfig
getEmbedLLMConfig(config)       // was getEmbeddingConfig
getSummariseLLMConfig(config)   // new
getQueryAnalyseLLMConfig(config) // new
getRespondLLMConfig(config)     // new
getComplexSynthesisLLMConfig(config) // new, fallback to respond
```

### New Env Vars

```
LLM_CLASSIFY_BASE_URL=
LLM_CLASSIFY_API_KEY=
LLM_CLASSIFY_MODEL=
LLM_EXTRACT_BASE_URL=
LLM_EXTRACT_API_KEY=
LLM_EXTRACT_MODEL=
LLM_SUMMARISE_BASE_URL=
LLM_SUMMARISE_API_KEY=
LLM_SUMMARISE_MODEL=
LLM_QUERY_ANALYSE_BASE_URL=
LLM_QUERY_ANALYSE_API_KEY=
LLM_QUERY_ANALYSE_MODEL=
LLM_RESPOND_BASE_URL=
LLM_RESPOND_API_KEY=
LLM_RESPOND_MODEL=
LLM_COMPLEX_BASE_URL=
LLM_COMPLEX_API_KEY=
LLM_COMPLEX_MODEL=
```

Existing `LLM_PASSIVE_*` and `LLM_CAPABLE_*` vars are kept as aliases for `classify` and
`extract`/`respond` respectively during transition.

---

## 7. New Infrastructure Adapters

| File | Role |
|---|---|
| `infrastructure/llm/OpenAIClassifierAdapter.ts` | Tier 1 classify (rename/refactor from `OpenAIConversationIntelligenceAdapter`) |
| `infrastructure/llm/OpenAIExtractionAdapter.ts` | Tier 2 deep extraction |
| `infrastructure/llm/OpenAISummarisationAdapter.ts` | Tier 4 rolling summaries |
| `infrastructure/llm/OpenAIQueryAnalysisAdapter.ts` | Pre-retrieval query planning |
| `infrastructure/persistence/postgres/PrismaEntityRepository.ts` | Entity + relationship CRUD |
| `infrastructure/persistence/postgres/PrismaConversationSignalRepository.ts` | Signal storage |
| `infrastructure/persistence/postgres/PrismaConversationSummaryRepository.ts` | Summary storage |
| `infrastructure/retrieval/MultiPathRetrievalEngine.ts` | Orchestrates 4 retrieval paths |
| `infrastructure/retrieval/StructuredRetrievalPath.ts` | SQL-based structured retrieval |
| `infrastructure/retrieval/GraphRetrievalPath.ts` | Entity-graph BFS |
| `infrastructure/retrieval/SummaryRetrievalPath.ts` | Rolling summary injection |

---

## 8. WireEventRouter Refactor

The current `WireEventRouter` is a 700+ line God Object that does classification, routing,
buffering, and response generation. It is split into:

```
WireEventRouter          — thin Wire event handler, delegates immediately to pipeline
    │
    └─► MessagePipeline  — orchestrates the 4 tiers per message
            │
            ├─► Tier1ClassifyStep    — classify model, returns intent + signal score
            ├─► Tier2ExtractStep     — extract model, returns structured entities
            ├─► Tier3EmbedStep       — embedding model, async, fire-and-forget
            └─► CommandRouter        — handles @mention commands (status, context, catch me up, etc.)
```

`WireEventRouter` retains Wire SDK event wiring (`handleTextMessage`, `onButtonAction`,
`onConversationMemberJoined`, etc.) but each handler immediately delegates to `MessagePipeline`.

**Existing contract tests are preserved** — the test suite mocks at the use-case level, which
remains stable. New tests cover the pipeline stages independently.

---

## 9. New Commands

| Command | Handler |
|---|---|
| `@Jeeves status` | `StatusCommand` — reports channel context, recent entity counts, last summary |
| `@Jeeves catch me up` / `@Jeeves what did I miss` | `CatchMeUpCommand` — returns most recent daily summary |
| `@Jeeves context: <text>` | `SetContextCommand` — updates `ConversationConfig.purpose` |
| `@Jeeves context type: <type>` | `SetContextCommand` — updates `contextType` |
| `@Jeeves context tags: <tags>` | `SetContextCommand` — updates `tags` |
| `@Jeeves context stakeholders: <mentions>` | `SetContextCommand` — updates `stakeholders` |

---

## 10. Implementation Phases

### Phase 1 — Foundation (DB + Config)

**Goal**: New schema in place, 7-model config wired, no functional regressions.

Tasks:
1. Write Prisma migration: add `conversation_signals`, `entities`, `entity_relationships`, `conversation_summaries`
2. Write Prisma migration: add new `ConversationConfig` columns; migrate `raw.purpose`
3. Add `PrismaEntityRepository`, `PrismaConversationSignalRepository`, `PrismaConversationSummaryRepository`
4. Extend `LLMConfigAdapter` with 7 model slot functions
5. Update `.env.example` and `docker-compose.yml` with new env vars
6. Update `container.ts` to wire new repos and adapters
7. All existing tests still pass

**Deliverable**: Schema + config foundation, no behaviour change.

### Phase 2 — Processing Pipeline

**Goal**: Tiered classification → extraction → embed. Extract-and-forget for new messages.

Tasks:
1. Create `ClassifierPort` and `OpenAIClassifierAdapter` (refactor from `OpenAIConversationIntelligenceAdapter`)
2. Create `ExtractionPort` and `OpenAIExtractionAdapter`
3. Create `MessagePipeline` class (Tier 1 + Tier 2 + Tier 3)
4. Route high-signal messages through `ExtractionAdapter` → write to `entities` + `entity_relationships`
5. Write `ConversationSignal` per message (all messages, lightweight)
6. Existing `Task`/`Action`/`Decision` use-cases continue to create their respective records — they now also write an `Entity` row (dual-write during transition)
7. Remove `rawMessage` content from new entity writes (keep column nullable for old rows)
8. Update `PendingActionBuffer` integration — matured actions flow through extraction
9. Update contract tests for new pipeline

**Deliverable**: Two-tier processing live. New messages don't store raw text.

### Phase 3 — Retrieval Engine

**Goal**: Multi-path retrieval replacing current keyword+semantic hybrid.

Tasks:
1. Create `QueryAnalysisPort` and `OpenAIQueryAnalysisAdapter`
2. Create `StructuredRetrievalPath` (SQL queries against Task/Action/Decision by filters)
3. Create `GraphRetrievalPath` (BFS over `entity_relationships`)
4. Create `SummaryRetrievalPath` (returns relevant `ConversationSummary` if temporal query)
5. Create `MultiPathRetrievalEngine` (orchestrates all 4 paths, merges via RRF)
6. Update `AnswerQuestion` to use `MultiPathRetrievalEngine` instead of `PrismaSearchAdapter`
7. Update `OpenAIGeneralAnswerAdapter` with richer context blocks
8. Implement decision contradiction detection (post-log similarity check)
9. Update tests

**Deliverable**: Retrieval quality dramatically improved; graph and summary paths live.

### Phase 4 — Summaries + Proactive

**Goal**: Rolling summaries, "catch me up", new context commands, `@Jeeves status`.

Tasks:
1. Create `SummarisationPort` and `OpenAISummarisationAdapter`
2. Create `GenerateSummary` use-case (reads signals for period → calls summarise model → writes summary)
3. Add `hourly_summary`, `daily_summary`, `weekly_summary` scheduled jobs to `InProcessScheduler`
4. Implement `CatchMeUpCommand` use-case
5. Implement `StatusCommand` use-case
6. Implement `SetContextCommand` use-case (with all sub-commands)
7. Wire all new commands into `WireEventRouter` / `CommandRouter`
8. Update contract tests for new commands
9. Remove `raw` JSON blob from `ConversationConfig` (after full migration)

**Deliverable**: Full v2.0 feature set live.

---

## 11. File Deletion / Renaming

| Current File | Action |
|---|---|
| `src/domain/services/ConversationIntelligenceService.ts` | Rename → `ClassifierService.ts` |
| `src/domain/services/ImplicitDetectionService.ts` | Delete (merged into ExtractionPort) |
| `src/infrastructure/llm/OpenAIConversationIntelligenceAdapter.ts` | Rename → `OpenAIClassifierAdapter.ts` |
| `src/infrastructure/llm/OpenAIImplicitDetectionAdapter.ts` | Delete |
| `src/infrastructure/llm/StubConversationIntelligenceAdapter.ts` | Rename → `StubClassifierAdapter.ts` |
| `src/infrastructure/llm/StubImplicitDetectionAdapter.ts` | Delete |
| `src/infrastructure/search/PrismaSearchAdapter.ts` | Becomes one path inside `MultiPathRetrievalEngine`; keep as `SemanticRetrievalPath.ts` |

---

## 12. Testing Strategy

### Unit Tests
- Each retrieval path tested independently with mocked repos
- `MessagePipeline` tested with mocked classifier/extractor
- `MultiPathRetrievalEngine` tested with mocked paths

### Contract Tests (existing style)
- Preserve all existing `WireEventRouter.contract.test.ts` tests
- Add new contracts for: pipeline flow, context commands, catch-me-up, status, contradiction detection

### Integration Tests
- Separate test that runs against a real Postgres (pgvector) instance
- Covers: entity write → embed → retrieve flow end-to-end

---

## 13. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Extract-and-forget breaks audit trail | Retain `rawMessageId`; audit log records the action taken |
| 7-model config is complex to operate | Each slot falls back gracefully; `.env.example` documents clearly |
| Entity graph grows unbounded | Add TTL to `entity_relationships`; mark stale edges on entity deletion |
| Summarisation costs (LLM calls per hour) | `hourly_summary` is optional/off by default; only `daily_summary` on by default |
| Contract test surface area doubles | New tests stay focused; stub adapters keep tests fast |
| Migration on existing DB with `rawMessage` data | Soft-delete approach: nullable columns added first, old data retained until Phase 2 complete, then dropped |

---

## 14. Open Questions (resolve before Phase 2)

1. **Entity deduplication**: If two messages extract the same fact ("Alice owns the API project"), do we create one entity or two? Need a dedup strategy (embeddings similarity before insert).
2. **Entity visibility**: Are entities scoped to conversation, or can they be cross-conversation for shared knowledge? Spec implies per-conversation but worth confirming.
3. **`rawMessage` retention policy for existing data**: Drop immediately on migration, or keep for a period and then clean up with a scheduled job?
4. **Contradiction threshold**: Cosine similarity 0.85 for decision contradiction — needs empirical tuning. Should be configurable.
5. **Hourly summary cost**: With many active channels, hourly summarisation runs `n_channels × 1 LLM call/hour`. Confirm acceptable or make opt-in per channel.
