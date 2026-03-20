# Jeeves v2.0 — Implementation Plan

> Branch: `v2.0`
> Based on: MVP Architecture v2.0 specification
> Current baseline: all v1 tests passing (63 pass, 7 skip), committed and pushed on `main`
> Open questions resolved: 2026-03-20

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

Two major additions over the initial spec:
- **Organisation scope**: entities are cross-conversation within an organisation boundary; the
  Wire domain string (`wire.com`, `staging.zinfra.io`, etc.) is used as the org identifier at
  MVP — no management UI required.
- **1:1 personal scope**: when Jeeves is in a DM with a single user, queries are scoped to that
  user's personal entities (tasks assigned to them, actions they own, decisions they participated
  in) across all organisation channels.

---

## 2. Resolved Design Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Entity deduplication | Pre-insert pgvector similarity check ≥ 0.92 within same org + entity type. Match → update existing; no match → insert new. |
| 2 | Entity visibility | Cross-conversation within org. Wire domain = orgId at MVP. 1:1 DM with bot = personal scope (user's entities across org). |
| 3 | rawMessage retention | Drop existing rawMessage content on Phase 1 migration. No re-processing of historical data. |
| 4 | Contradiction threshold | Two-step: similarity ≥ 0.78 flags "same topic", then classify model asks "does B contradict A?". Threshold configurable via `DECISION_CONTRADICTION_THRESHOLD` env var (default 0.78). Suppress if both decisions < 30 min old. |
| 5 | Summaries | Daily morning summary at 08:00 per channel timezone. Weekly summary Monday 08:00. No hourly summaries. "Catch me up" / "what did I miss" triggers on-demand generation for the past 24 h (or since user's last message in channel). |

---

## 3. What is Preserved from v1

| Component | Status | Notes |
|---|---|---|
| Hexagonal architecture (ports/adapters) | Keep | Clean layering is good; domain stays stable |
| `Task`, `Action`, `Decision`, `Reminder` domain entities | Keep with changes | Remove `rawMessage` fields; add `organisationId` |
| `KnowledgeEntry` | Restructure | Merged into `Entity` model; keep `embedding` column |
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

## 4. What Changes Fundamentally

### 4.1 Organisation Scope

Every entity, conversation config, and signal is now scoped to an **organisation**. At MVP the
`organisationId` is simply the Wire domain of the bot's own account (e.g. `wire.com`). No
management UI or provisioning flow is needed — the bot reads its own domain from config on
startup and stamps every write with it.

```
orgId = config.wire.userDomain   // e.g. "wire.com"
```

Retrieval always filters by `organisationId` before returning results. This is the primary
data isolation boundary.

**1:1 DM scope**: when a conversation has exactly two members (the bot + one human), Jeeves
operates in *personal mode*:
- "My tasks", "my actions", "my reminders" queries are scoped across the entire org, filtered
  to `assigneeId = userId OR authorId = userId`
- The member is told: "I can see everything assigned to you across all your organisation's
  channels."
- This is detected by checking `memberCache.getMembers(convId).length === 2` at runtime.

### 4.2 Extract-and-Forget

**Every** `rawMessage` field is removed from the DB schema. Currently stored in:
- `Task.rawMessage` / `Task.rawMessageId`
- `Action.rawMessage` / `Action.rawMessageId`
- `Decision.rawMessage` / `Decision.rawMessageId`
- `KnowledgeEntry.rawMessage` / `KnowledgeEntry.rawMessageId`
- `Reminder.rawMessage` / `Reminder.rawMessageId`

These fields are replaced by a per-message processing pipeline that extracts structured data
first, then drops the text. The `rawMessageId` (Wire message ID) is retained as a reference key
for threading/reactions but the content string is not stored. Existing `rawMessage` content in
the DB is dropped on the Phase 1 migration — no re-processing of historical data.

### 4.3 Processing Pipeline (Four Tiers)

```
Every message
    │
    ▼
Tier 1: Classify  ──── fast model (classify) ────►  intent + signal score
    │
    ├─ low signal ──────────────────────────────►  write ConversationSignal only
    │
    └─ high signal
           │
           ▼
       Tier 2: Extract  ─── deep model (extract) ──►  structured entities
           │
           ├─► Entity rows (dedup via similarity ≥ 0.92)
           └─► EntityRelationship rows upserted
                   │
                   ▼
               Tier 3: Embed  ─── embedding model ──►  entity.embedding updated (async)
                   │
                   ▼
               Scheduled:
               Tier 4: Summarise ─── summarise model ─►  ConversationSummary row
```

### 4.4 Seven LLM Model Slots

| Slot | Env Var prefix | Purpose | Current equivalent |
|---|---|---|---|
| `classify` | `LLM_CLASSIFY_` | Tier 1: every message, fast | `LLM_PASSIVE_` |
| `extract` | `LLM_EXTRACT_` | Tier 2: deep extraction | `LLM_CAPABLE_` (implicit) |
| `embed` | `LLM_EMBED_` | pgvector embeddings | `LLM_EMBEDDING_` |
| `summarise` | `LLM_SUMMARISE_` | Daily/weekly/on-demand summaries | new |
| `queryAnalyse` | `LLM_QUERY_ANALYSE_` | Query decomposition before retrieval | new |
| `respond` | `LLM_RESPOND_` | Final Jeeves answer | `LLM_CAPABLE_` |
| `complexSynthesis` | `LLM_COMPLEX_` | Multi-source synthesis (optional) | new |

Each slot has `BASE_URL`, `API_KEY`, `MODEL`, `ENABLED` suffixes. Disabled slots fall back:
`complexSynthesis` → `respond`; `queryAnalyse` → `respond`; `summarise` → `respond`;
`extract` → `respond`; `classify` → `extract`. `embed` has no fallback (embeddings optional).

Existing `LLM_PASSIVE_*` / `LLM_CAPABLE_*` vars kept as aliases during transition.

### 4.5 Channel Context (Enriched)

`ConversationConfig.raw` blob replaced by proper typed columns:

| Column | Type | Description |
|---|---|---|
| `purpose` | `TEXT` | What the channel is for (existing, promoted from raw) |
| `contextType` | `TEXT` | `general \| project \| incident \| decision \| standup \| customer` |
| `tags` | `TEXT[]` | e.g. `['alpha', 'mobile', 'q1']` |
| `stakeholders` | `TEXT[]` | Wire user IDs of key people |
| `relatedChannels` | `TEXT[]` | Conversation IDs of related channels |
| `organisationId` | `TEXT` | Wire domain, set on first write |

### 4.6 Entity Graph

`Entity` is a single unified node table — it supersedes `KnowledgeEntry` and mirrors the
structured fields of tasks/actions/decisions for graph connectivity.

`EntityRelationship` stores typed directed edges:
- `owns` — person owns a task or action
- `depends_on` — task/action depends on another
- `works_on` — person works on a project or entity
- `blocks` — one entity blocks another
- `reports_to` — org hierarchy edge

Retrieval can BFS-traverse these edges: "what is blocking the Alpha deployment?" walks
`blocks` edges from the Alpha project entity.

**Deduplication**: before inserting any new `Entity`, the extraction pipeline runs a pgvector
search for existing entities with the same `entityType` and `organisationId` where cosine
similarity ≥ 0.92. If found, it updates `summary`, `detail`, `updatedAt` and increments
`mentionCount`; no new row is created. Threshold configurable via `ENTITY_DEDUP_THRESHOLD`
(default 0.92).

### 4.7 Summaries

Scheduled jobs fire per active channel (any channel where a message was received in the past 7
days):

| Job | Schedule | Default |
|---|---|---|
| `daily_summary` | 08:00 per channel timezone | On |
| `weekly_summary` | Monday 08:00 per channel timezone | On |

"Catch me up" / "what did I miss" (and variants) triggers an on-demand summary covering:
- Last 24 hours of `ConversationSignal` records for the channel, OR
- Since the requesting user's last message in the channel — whichever is shorter

The summary is generated by the `summarise` model and posted to the channel immediately.

### 4.8 Multi-Path Retrieval

```
Query → QueryAnalyser
              │
              ├─ Path 1: Structured SQL   (Task/Action/Decision filtered by status/date/person)
              ├─ Path 2: Semantic pgvector (HNSW on entities.embedding, existing hybrid RRF)
              ├─ Path 3: Entity graph     (BFS from named entities in query)
              └─ Path 4: Summary          (inject daily summary if temporal/catch-up query)
                   │
                   ▼
              RRF merge → top-k results → injected into LLM prompt
```

### 4.9 Decision Contradiction Detection

After each new decision is confirmed:
1. pgvector similarity search against decisions in the same org from the past 90 days
2. Any decision with cosine similarity ≥ `DECISION_CONTRADICTION_THRESHOLD` (default 0.78) is
   a "same topic" candidate
3. For each candidate, the `classify` model is asked: "Does decision B contradict decision A?
   Answer yes or no." (single cheap call per candidate, typically ≤ 2 candidates)
4. If any candidate returns "yes" and both decisions are > 30 minutes old, Jeeves posts:
   > "I notice this may contradict decision DEC-0003 from 12 March (*We will use REST APIs*).
   > Shall I mark it superseded?"
5. Button actions: `supersede_decision` (existing) or `dismiss_contradiction`

---

## 5. Database Schema Changes

### 5.1 New Tables

```prisma
model ConversationSignal {
  id              String   @id
  organisationId  String
  conversationId  String
  conversationDom String
  messageId       String
  authorId        String
  authorDom       String
  signalType      String   // 'task_mention','decision','action','question','general'
  confidence      Float
  timestamp       DateTime
  processed       Boolean  @default(false)

  @@index([conversationId, conversationDom, timestamp])
  @@index([organisationId, timestamp])
  @@map("conversation_signals")
}

model Entity {
  id              String   @id
  organisationId  String
  sourceConvId    String   // conversation where first extracted
  sourceConvDom   String
  entityType      String   // 'task','action','decision','fact','person','project'
  label           String   // short human-readable name
  summary         String
  detail          String?
  category        String?
  confidence      String?
  tags            String[]
  ttlDays         Int?
  mentionCount    Int      @default(1)
  embedding       Unsupported("vector(1024)")?
  createdAt       DateTime
  updatedAt       DateTime
  deleted         Boolean  @default(false)

  fromRelationships EntityRelationship[] @relation("from")
  toRelationships   EntityRelationship[] @relation("to")

  @@index([organisationId, entityType])
  @@map("entities")
}

model EntityRelationship {
  id             String   @id
  fromEntityId   String
  toEntityId     String
  relationType   String   // 'owns','depends_on','works_on','blocks','reports_to'
  weight         Float    @default(1.0)
  createdAt      DateTime

  from Entity @relation("from", fields: [fromEntityId], references: [id])
  to   Entity @relation("to",   fields: [toEntityId],   references: [id])

  @@index([fromEntityId])
  @@index([toEntityId])
  @@map("entity_relationships")
}

model ConversationSummary {
  id              String   @id
  organisationId  String
  conversationId  String
  conversationDom String
  granularity     String   // 'daily','weekly','on_demand'
  periodStart     DateTime
  periodEnd       DateTime
  content         String
  createdAt       DateTime

  @@index([conversationId, conversationDom, granularity, periodStart])
  @@map("conversation_summaries")
}
```

### 5.2 Modified Tables

**`Task`, `Action`, `Decision`, `KnowledgeEntry`, `Reminder`**:
- Add: `organisationId TEXT NOT NULL DEFAULT ''` (populated on migration from `conversationDom`)
- Remove: `rawMessage TEXT` (dropped immediately on Phase 1 migration)
- Keep: `rawMessageId TEXT`

**`ConversationConfig`**:
- Add: `organisationId TEXT`, `contextType TEXT`, `tags TEXT[]`, `stakeholders TEXT[]`,
  `relatedChannels TEXT[]`, `purpose TEXT`
- Migrate: `raw.purpose` → `purpose` column in Phase 1 migration script
- Remove: `raw JSON` (after migration complete)

**`AuditLog`**:
- Add: `organisationId TEXT`

### 5.3 Migration Order

1. Add `organisationId` to all existing tables (nullable initially, `DEFAULT ''` for old rows)
2. Backfill `organisationId` from `conversationDom` on all existing rows via migration SQL
3. Add `purpose TEXT` column to `ConversationConfig`; migrate from `raw` blob
4. Add new `ConversationConfig` columns (`contextType`, `tags`, `stakeholders`, `relatedChannels`)
5. Drop `rawMessage` columns from all entity tables
6. Drop `raw JSON` column from `ConversationConfig`
7. Create `conversation_signals`, `entities`, `entity_relationships`, `conversation_summaries`
8. Add HNSW index on `entities.embedding`
9. Make `organisationId` NOT NULL once backfill confirmed

---

## 6. New/Changed Application Ports

```typescript
// application/ports/ClassifierPort.ts
export interface ClassifierPort {
  classify(text: string, context: string[], members?: MemberContext[]): Promise<ClassifyResult>;
}
export interface ClassifyResult {
  intent: string;
  signalScore: number;   // 0–1
  captureHints: string[]; // hints for Tier 2
}

// application/ports/ExtractionPort.ts
export interface ExtractionPort {
  extract(text: string, hints: string[], context: ExtractContext): Promise<ExtractResult>;
}
export interface ExtractContext {
  organisationId: string;
  conversationId: QualifiedId;
  authorId: QualifiedId;
  members: MemberContext[];
  purpose?: string;
}
export interface ExtractResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

// application/ports/SummarisationPort.ts
export interface SummarisationPort {
  summarise(signals: ConversationSignal[], granularity: 'daily'|'weekly'|'on_demand',
            context: SummariseContext): Promise<string>;
}

// application/ports/QueryAnalysisPort.ts
export interface QueryAnalysisPort {
  analyse(query: string, context: string[], members: MemberContext[]): Promise<QueryPlan>;
}
export interface QueryPlan {
  paths: Array<'structured'|'semantic'|'graph'|'summary'>;
  filters: Record<string, unknown>;  // status, assignee, dateRange, etc.
  expansions: string[];  // entity labels to graph-traverse from
  isTemporal: boolean;   // true → include summary path
  isPersonal: boolean;   // true → filter to requesting user
}

// application/ports/RetrievalPort.ts
export interface RetrievalPort {
  retrieve(plan: QueryPlan, scope: RetrievalScope): Promise<RetrievalResult[]>;
}
export interface RetrievalScope {
  organisationId: string;
  conversationId?: QualifiedId;  // undefined = org-wide
  userId?: QualifiedId;          // defined in personal/1:1 mode
}
```

**`GeneralAnswerPort`** updated:
```typescript
answer(question, conversationContext, retrieval: RetrievalResult[],
       members?, purpose?, contextType?): Promise<string>
```

---

## 7. LLM Configuration

### New Env Vars

Each slot uses `BASE_URL`, `API_KEY`, `MODEL`, `ENABLED`:

```
# Tier 1 — classify every message (fast, cheap)
LLM_CLASSIFY_BASE_URL=
LLM_CLASSIFY_API_KEY=
LLM_CLASSIFY_MODEL=

# Tier 2 — deep extraction (capable)
LLM_EXTRACT_BASE_URL=
LLM_EXTRACT_API_KEY=
LLM_EXTRACT_MODEL=

# Tier 3 — embeddings
LLM_EMBED_BASE_URL=        # was LLM_EMBEDDING_BASE_URL
LLM_EMBED_API_KEY=
LLM_EMBED_MODEL=
LLM_EMBED_DIMS=1024

# Tier 4 — summarisation
LLM_SUMMARISE_BASE_URL=
LLM_SUMMARISE_API_KEY=
LLM_SUMMARISE_MODEL=

# Retrieval — query analysis
LLM_QUERY_ANALYSE_BASE_URL=
LLM_QUERY_ANALYSE_API_KEY=
LLM_QUERY_ANALYSE_MODEL=

# Response — Jeeves answers
LLM_RESPOND_BASE_URL=
LLM_RESPOND_API_KEY=
LLM_RESPOND_MODEL=

# Complex synthesis (optional — falls back to respond)
LLM_COMPLEX_BASE_URL=
LLM_COMPLEX_API_KEY=
LLM_COMPLEX_MODEL=

# Contradiction detection
DECISION_CONTRADICTION_THRESHOLD=0.78

# Entity deduplication
ENTITY_DEDUP_THRESHOLD=0.92
```

`LLM_PASSIVE_*` and `LLM_CAPABLE_*` kept as aliases → `classify` and `respond` respectively.

---

## 8. New Infrastructure Adapters

| File | Role |
|---|---|
| `infrastructure/llm/OpenAIClassifierAdapter.ts` | Tier 1 (refactor from `OpenAIConversationIntelligenceAdapter`) |
| `infrastructure/llm/OpenAIExtractionAdapter.ts` | Tier 2 deep extraction |
| `infrastructure/llm/OpenAISummarisationAdapter.ts` | Daily/weekly/on-demand summaries |
| `infrastructure/llm/OpenAIQueryAnalysisAdapter.ts` | Pre-retrieval query planning |
| `infrastructure/persistence/postgres/PrismaEntityRepository.ts` | Entity + relationship CRUD + dedup query |
| `infrastructure/persistence/postgres/PrismaConversationSignalRepository.ts` | Signal writes + period reads |
| `infrastructure/persistence/postgres/PrismaConversationSummaryRepository.ts` | Summary writes + latest-per-channel reads |
| `infrastructure/retrieval/MultiPathRetrievalEngine.ts` | Orchestrates 4 paths, merges via RRF |
| `infrastructure/retrieval/StructuredRetrievalPath.ts` | SQL-based structured retrieval |
| `infrastructure/retrieval/SemanticRetrievalPath.ts` | Renamed from `PrismaSearchAdapter` |
| `infrastructure/retrieval/GraphRetrievalPath.ts` | BFS over entity_relationships |
| `infrastructure/retrieval/SummaryRetrievalPath.ts` | Injects relevant ConversationSummary |

---

## 9. WireEventRouter Refactor

Current `WireEventRouter` (~700 lines) is split:

```
WireEventRouter       — thin Wire event handler only
    │
    └─► MessagePipeline
            │
            ├─► Tier1ClassifyStep     (ClassifierPort)
            ├─► Tier2ExtractStep      (ExtractionPort → EntityRepository)
            ├─► Tier3EmbedStep        (EmbeddingPort, async fire-and-forget)
            └─► CommandRouter
                    ├─► @mention commands (status, catch me up, context:, knowledge, tasks, etc.)
                    └─► Button action handler (promote action, confirm/dismiss task/decision)
```

**Personal mode detection** in `MessagePipeline`:
```typescript
const members = await memberCache.getMembers(convId);
const isPersonalMode = members.length === 2;  // bot + 1 human
```
Personal mode sets `RetrievalScope.userId` so queries run org-wide filtered to that user.

---

## 10. New Commands

| Command | Use-case | Notes |
|---|---|---|
| `@Jeeves status` | `StatusCommand` | Channel context, entity counts by type, last summary date |
| `@Jeeves catch me up` / `what did I miss` | `CatchMeUpCommand` | On-demand summary: 24 h or since last user message |
| `@Jeeves context: <text>` | `SetContextCommand` | Update `purpose` |
| `@Jeeves context type: <type>` | `SetContextCommand` | Update `contextType` |
| `@Jeeves context tags: <tags>` | `SetContextCommand` | Update `tags` |
| `@Jeeves context stakeholders: @x @y` | `SetContextCommand` | Update `stakeholders` |

---

## 11. Implementation Phases

### Phase 1 — Foundation: Schema + Organisation + Config
**Goal**: New schema live, organisation scope wired, 7-model config, no behaviour change.

1. Prisma migration: add `organisationId` to all existing tables; backfill from `conversationDom`
2. Prisma migration: promote `purpose` to column on `ConversationConfig`; add `contextType`, `tags`, `stakeholders`, `relatedChannels`; drop `raw`
3. Prisma migration: drop `rawMessage` from all entity tables
4. Prisma migration: create `conversation_signals`, `entities`, `entity_relationships`, `conversation_summaries`; add HNSW index
5. Add `PrismaEntityRepository`, `PrismaConversationSignalRepository`, `PrismaConversationSummaryRepository`
6. Extend `LLMConfigAdapter` with 7 slot functions + `DECISION_CONTRADICTION_THRESHOLD` + `ENTITY_DEDUP_THRESHOLD`
7. Stamp `organisationId = config.wire.userDomain` on all new writes throughout existing use-cases
8. Update `PrismaConversationConfigRepository` to read/write new typed columns
9. Update `.env.example` and `docker-compose.yml`
10. **Gate**: all existing tests pass

### Phase 2 — Processing Pipeline
**Goal**: Four-tier pipeline live; extract-and-forget for new messages.

1. Create `ClassifierPort` + `OpenAIClassifierAdapter` (refactor from `OpenAIConversationIntelligenceAdapter`)
2. Create `ExtractionPort` + `OpenAIExtractionAdapter`
3. Create `MessagePipeline` (Tier 1 → Tier 2 → Tier 3)
4. Write `ConversationSignal` per message (all messages, Tier 1 result)
5. High-signal messages: run extraction → write `Entity` rows with dedup check (≥ 0.92)
6. Write `EntityRelationship` rows from extraction result
7. Tier 3: async embed on new/updated entities
8. `PendingActionBuffer` matured actions → pass through extraction before persisting
9. Detect personal mode (2-member conv) in `MessagePipeline`; set `RetrievalScope.userId`
10. Update contract tests for pipeline
11. **Gate**: tests pass; new messages produce no `rawMessage` in DB

### Phase 3 — Retrieval Engine
**Goal**: Multi-path retrieval replaces current keyword+semantic.

1. Create `QueryAnalysisPort` + `OpenAIQueryAnalysisAdapter`
2. Create `StructuredRetrievalPath` (SQL, respects org/conv/user scope)
3. Rename `PrismaSearchAdapter` → `SemanticRetrievalPath`; update to use `Entity` table
4. Create `GraphRetrievalPath` (BFS on `entity_relationships`, depth ≤ 3)
5. Create `SummaryRetrievalPath` (returns latest `ConversationSummary` if `isTemporal`)
6. Create `MultiPathRetrievalEngine` (orchestrates all 4, merges via RRF)
7. Update `AnswerQuestion` to use `MultiPathRetrievalEngine` + `RetrievalScope`
8. Update `OpenAIGeneralAnswerAdapter` with richer context (contextType, org-wide scope note)
9. Decision contradiction detection (post-log two-step: similarity → classify)
10. Update tests
11. **Gate**: "catch me up" retrieval works; org-wide personal queries work

### Phase 4 — Summaries + Commands
**Goal**: Scheduled summaries, new commands, full v2.0 feature set.

1. Create `SummarisationPort` + `OpenAISummarisationAdapter`
2. Create `GenerateSummary` use-case (reads signals → summarise model → write `ConversationSummary`)
3. `InProcessScheduler`: add `daily_summary` (08:00 per timezone) and `weekly_summary` (Monday 08:00) jobs
4. Implement `CatchMeUpCommand` (on-demand, posts to channel)
5. Implement `StatusCommand`
6. Implement `SetContextCommand` (all sub-commands)
7. Wire all new commands into `CommandRouter`
8. Inject daily summary into LLM context automatically when answering questions
9. Update contract tests for all new commands
10. **Gate**: full test suite passes; all commands work end-to-end

---

## 12. File Deletions / Renames

| Current | Action |
|---|---|
| `src/domain/services/ConversationIntelligenceService.ts` | Rename → `ClassifierService.ts` |
| `src/domain/services/ImplicitDetectionService.ts` | Delete (merged into ExtractionPort) |
| `src/infrastructure/llm/OpenAIConversationIntelligenceAdapter.ts` | Rename → `OpenAIClassifierAdapter.ts` |
| `src/infrastructure/llm/OpenAIImplicitDetectionAdapter.ts` | Delete |
| `src/infrastructure/llm/StubConversationIntelligenceAdapter.ts` | Rename → `StubClassifierAdapter.ts` |
| `src/infrastructure/llm/StubImplicitDetectionAdapter.ts` | Delete |
| `src/infrastructure/search/PrismaSearchAdapter.ts` | Rename → `SemanticRetrievalPath.ts`; update to use `entities` table |
| `src/application/usecases/knowledge/` (all) | Migrate: `StoreKnowledge`, `RetrieveKnowledge`, `ListKnowledge`, `DeleteKnowledge`, `UpdateKnowledge` → operate on `Entity` table via `PrismaEntityRepository` |

---

## 13. Testing Strategy

### Unit Tests
- Each retrieval path independently with mocked repos
- `MessagePipeline` with mocked classifier/extractor (Tier 1 → Tier 2 → Tier 3)
- `MultiPathRetrievalEngine` with mocked paths
- Entity dedup logic: same-type high-similarity → update, low-similarity → insert

### Contract Tests (existing style)
- All existing `WireEventRouter.contract.test.ts` tests preserved
- New contracts: pipeline flow, context commands, catch-me-up, status, contradiction detection, personal mode

### Integration Tests
- Real Postgres (pgvector): entity write → embed → dedup check → retrieve end-to-end
- Organisation isolation: entities from org A not returned for org B queries

---

## 14. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `organisationId` backfill leaves empty strings | Migration validates non-empty before making NOT NULL; guard in repos |
| Dedup threshold (0.92) too aggressive → lost context | Log dedup merges; `mentionCount` provides audit; threshold configurable |
| Dedup threshold too low → false merges | 0.92 chosen conservatively; same-type filter further narrows candidates |
| Entity graph grows unbounded | `EntityRelationship` gets a `staleness` flag; cleanup job marks edges stale on entity soft-delete |
| Personal mode exposes cross-channel data unintentionally | Always confirm scope in Jeeves response: "Across all channels in your organisation, you have…" |
| Contradiction detection false positives | Two-step approach + 30-min suppression; user can always dismiss |
| Daily summary runs before channel has any signals | `GenerateSummary` is a no-op if signal count = 0 for period |
| rawMessage drop breaks existing tests | Contracts updated in Phase 1 alongside schema; no test uses rawMessage content directly |
