# Jeeves v2.0 — Implementation Plan

> Branch: `v2.0`
> Spec: MVP Architecture and Implementation Specification v2.0 (March 2026)
> Current baseline: all v1 tests passing (63 pass, 7 skip), committed and pushed on `main`
> Open questions resolved: 2026-03-20
> Spec gap analysis complete: 2026-03-20

---

## 1. Executive Summary

v2.0 is a fundamental architectural shift. The core principle is **extract-and-forget**: raw
message text is processed in-memory, structured knowledge is extracted, and the original
content is discarded. Nothing goes to an AI service unless the bot has explicit permission.
Nothing persists that cannot be justified as durable team knowledge.

The processing model moves from a single-pass intent classifier to a **four-tier pipeline**:
fast classification → deep extraction → async embedding → scheduled summarisation.
Retrieval moves from keyword + semantic to a **multi-path engine**: structured SQL, pgvector
similarity, entity-graph traversal, and rolling summaries.

**Two additions over the spec** (resolved with user):
- Organisation scope: entities are cross-conversation, scoped to a Wire domain as orgId.
- 1:1 DM personal scope: when in a 2-member conversation, queries run org-wide filtered to
  the requesting user.

---

## 2. Resolved Design Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Entity deduplication | Pre-insert pgvector similarity ≥ 0.92 within same org + entity type. Match → update existing; no match → insert. |
| 2 | Entity visibility | Cross-conversation within org. Wire domain = orgId at MVP. 1:1 DM = personal scope (user's entities across org). |
| 3 | rawMessage retention | Drop existing rawMessage content in Phase 1 migration. Populate `source_ref` from `rawMessageId` before dropping. |
| 4 | Contradiction threshold | Two-step: similarity ≥ 0.78 → classify model asks "does B contradict A?". Configurable via `JEEVES_CONTRADICTION_THRESHOLD` (default 0.78). Suppress if both decisions < 30 min old. |
| 5 | Summaries | Daily at 08:00 per channel timezone, weekly Monday 08:00. No hourly scheduled summaries. "Catch me up" = on-demand (last 24 h or since user's last message). |
| 6 | ORM | **Keep Prisma**. Spec recommends Drizzle but migration is high-cost, low-value at this stage. Post-MVP item. |
| 7 | Tasks vs Actions | **Task entity is retired.** Tasks and actions are the same concept. Existing `Task` use-cases and DB table are removed. Existing task records migrated to `actions` or dropped (dev data). |
| 8 | Button action UX | **Remove specific implementations** (confirm_task, confirm_decision, confirm_action, confirm_knowledge). **Retain the infrastructure** — `CompositeMessage` + button sending + `onButtonActionReceived` handler pattern — for future use cases like reassignment confirmation. |
| 9 | Phase 1 scope | Split into **Phase 1a** (schema additions + channel state machine, no drops) and **Phase 1b** (schema drops, Task retirement, KnowledgeEntry removal, test updates). Existing tests must pass at end of 1a. |
| 10 | `channel_id` convention | `"{conversationId}@{conversationDom}"` — matches Wire SDK `QualifiedId`. New tables use this single field. Existing tables keep split fields; a `toChannelId(q: QualifiedId)` helper converts at boundaries. |
| 11 | Personal mode detection | `members.filter(m => m.userId.id !== botUserId.id).length === 1`. Bot IS included in the Wire member list. Updated on `onUserJoinedConversation` / `onUserLeftConversation` events. |
| 12 | Embedding dims | Configurable via `JEEVES_EMBED_DIMS`. On startup, if embedding enabled, make one test embed call and assert vector length matches config. If mismatch: log error, disable embedding, continue. Default 1024 (bge-m3 fallback). **Confirmed dims for qwen3-embedding:4b must be set before running Phase 2 migration.** |
| 13 | Queue size cap | `InMemoryProcessingQueue` max depth 500 messages (sentences-short, negligible memory). On overflow: drop oldest unprocessed job, emit a warning log. |
| 14 | Extraction pipeline errors | If Tier 2 extraction fails (timeout, malformed JSON): log error, write a `ConversationSignal` with `signal_type: 'discussion'`, confidence 0.3, as a fallback record. Never crash the pipeline. |

---

## 3. Key Technology Decisions (vs Spec)

### 3.1 ORM: Prisma (keep) not Drizzle (spec recommendation)

The spec recommends Drizzle ORM. The existing codebase uses Prisma throughout. Migrating
ORMs would require rewriting every repository, all migrations, and all test fixtures for no user-
facing gain. **Decision: keep Prisma.** Mark Drizzle as post-MVP technical debt if desired.

### 3.2 Queue: In-Memory Async Queue (no Redis at MVP)

The spec recommends BullMQ + Redis for the processing queue (TTL 60s). **We are not
adding Redis at MVP.** Reasons:

- The 60s TTL exists to prevent message content lingering in Redis. With no Redis, content
  only ever lives in Node.js process memory during processing — strictly better for
  extract-and-forget.
- Processing surviving a restart is explicitly undesirable (the sliding window is designed to be
  lost on restart).
- BullMQ is only necessary for horizontal scaling (multiple bot instances) or volumes that
  exceed single-process capacity — neither applies at MVP.

**Replacement**: a lightweight `InMemoryProcessingQueue` (concurrency-limited async worker
pool, max 5 concurrent extractions) handles all Tier 1→Tier 2→Tier 3 jobs. Message content
is GC'd naturally when the processing function returns.

```
InProcessScheduler         → daily_summary, weekly_summary, staleness_check (durable)
InMemoryProcessingQueue    → classify, extract, embed (transient, in-process)
```

**Redis / BullMQ**: deferred to the horizontal-scaling milestone. When added, only the
`InMemoryProcessingQueue` is replaced; everything else is unchanged.

### 3.3 Embedding Dimensions

Spec specifies `vector(1536)` for the `qwen3-embedding:4b` model. Our current schema uses
`vector(1024)` (for bge-m3:567m). The actual output dimension of `qwen3-embedding:4b` must
be confirmed before writing the Phase 2 migration. The dimension is configurable via
`JEEVES_EMBED_DIMS` env var; default should match the model's actual output.

Fallback embedding model `bge-m3:567m` outputs 1024 dims — if both models are used, the
column must be sized to the larger model (1536) with null padding for smaller outputs, or we
standardise on one dimension. **Decision: use `JEEVES_EMBED_DIMS`, default 1024, with a
migration to change dimension if `qwen3-embedding:4b` confirms 1536.**

---

## 4. What is Preserved from v1

| Component | Status | Notes |
|---|---|---|
| Hexagonal architecture (ports/adapters) | Keep | Domain stays stable |
| `Task`, `Reminder` domain entities | Keep, adapt | Add `source_ref`, `confidence`; remove `rawMessage` |
| `Decision`, `Action` domain entities | Significantly adapt | Add spec fields: `rationale`, `decidedAt`, `confidence`, `sourceRef`, `staleness_at` etc. |
| `KnowledgeEntry` | Replace | Superseded by `Entity` + `embeddings` tables |
| `ConversationConfig` | Adapt | Add state machine, new context fields, `joined_at` |
| Prisma + PostgreSQL + pgvector | Keep | Add new tables via migrations |
| `WireEventRouter` | Heavily refactor | Split into pipeline + command router |
| `OpenAIEmbeddingAdapter` | Keep | Retarget to `qwen3-embedding:4b` |
| `InProcessScheduler` | Keep | Add daily_summary, weekly_summary, staleness_check |
| `OverdueNudgeService` | Remove in Phase 1b | Replaced by staleness detection scheduled job (Phase 4, §12.1). Query logic reused. |
| `WeeklyDigestService` | Remove in Phase 1b | Replaced by `GenerateSummary` use-case + weekly scheduler (Phase 4). Logic reused. |
| `ConversationMessageBuffer` | Replace | Becomes the spec's `SlidingWindow` ring buffer |
| `PendingActionBuffer` | Remove | Replaced by `InMemoryProcessingQueue` + Tier 2 extraction |
| `InMemoryMemberCache` | Keep | Still needed for member injection + access scoping |
| `WireOutboundAdapter` | Keep | No changes |
| Existing use-case classes (tasks, reminders) | Keep, adapt | Source ref changes |
| Contract test suite | Extend | Do not break existing tests |

---

## 5. What Changes Fundamentally

### 5.1 Channel State Machine (ACTIVE / PAUSED / SECURE)

Three formal states — not the current boolean `secretMode`:

| State | Behaviour | Trigger | Response |
|---|---|---|---|
| **ACTIVE** | Full processing | Default on join; `@Jeeves resume` | "Very good. I shall resume my duties forthwith." |
| **PAUSED** | Discard all messages silently. Still respond to direct @Jeeves commands. | `@Jeeves pause` / `step out` | "Understood. I shall step out. Do let me know when you require my attention again." |
| **SECURE** | Same as PAUSED + flush sliding window buffer immediately + record `secure_ranges` marker. Context before/after secure period not used for inference. | `@Jeeves secure mode` / `ears off` | "Of course. I have cleared my short-term recollection of this channel and shall disregard all proceedings until further notice." |

Current `secretMode` boolean maps to SECURE. The PAUSED state is new and distinct.
`secure_ranges` is a JSONB array of `{start, end}` timestamps so the extractor can avoid
using surrounding context from secure periods.

### 5.2 Extract-and-Forget

`rawMessage` is removed from all entity tables. `source_ref JSONB` replaces `rawMessageId`:

```json
{
  "wire_msg_ids": ["<Wire message ID 1>", "<Wire message ID 2>"],
  "timestamp_range": { "start": "2026-03-20T09:00:00Z", "end": "2026-03-20T09:01:00Z" }
}
```

This is richer — a decision may span multiple messages. The message IDs can be used for
deep-linking back to Wire but contain no content.

### 5.3 `channel_id` Convention

The spec uses a single `channel_id TEXT`. Wire uses qualified IDs (`id + domain`). Convention:

```
channel_id = "{conversationId}@{conversationDom}"
// e.g. "4b88498a-7e39-4f8c-86e1-9bb4a7697ea4@wire.com"
```

All new tables use this single `channel_id TEXT` field. Existing tables (Task, Action, Decision,
Reminder) keep their split `conversationId + conversationDom` for backwards compatibility;
new tables use `channel_id`.

### 5.4 Processing Pipeline (Four Tiers)

```
Every message in ACTIVE channel
    │
    ▼
[InMemoryProcessingQueue job]
    │
    ▼
Tier 1: Classify  ── qwen3-2507:4b ──►  {categories[], confidence, entities[], is_high_signal}
    │
    ├─ is_high_signal = false ─────────►  write ConversationSignal only (lightweight)
    │
    └─ is_high_signal = true
           │
           ▼
       Tier 2: Extract  ── qwen3-2507:30b-a3b ──►  decisions[], actions[], entities[], signals[]
           │                  (sliding window of last 30 msgs as context)
           ├─► Decision rows (source_ref, confidence, rationale, decided_by)
           ├─► Action rows (source_ref, confidence, staleness_at, related_decision)
           ├─► Entity rows (dedup check ≥ 0.92, aliases, observation_count++)
           ├─► EntityRelationship rows (UNIQUE constraint handles dedup)
           └─► ConversationSignal rows
                   │
                   ▼
               Tier 3: Embed  ── qwen3-embedding:4b ──►  embeddings table row
                   (text discarded after vector computed)
```

Tier 4 (Summarise) is scheduled, not triggered per-message.

### 5.5 Classification Output

Tier 1 returns multiple categories (not a single intent):

```typescript
interface ClassifyResult {
  categories: Array<'decision' | 'action' | 'question' | 'blocker' |
                    'update' | 'discussion' | 'reference' | 'routine'>;
  confidence: number;       // 0–1
  entities: string[];       // Named entities mentioned (used by Tier 2)
  is_high_signal: boolean;  // true if decision | action | blocker
}
```

### 5.6 Separate `embeddings` Table

Embeddings are stored in a standalone table, NOT as a column on entities. This is spec §4.4.
The embedding table holds vectors for decisions, message-level signals, topics, and summaries
— not just entities. The source text is discarded after the vector is computed.

### 5.7 Summaries (Spec Hierarchy + User Decision)

Spec defines hourly → daily → weekly roll-ups. User decision: no hourly scheduled runs. Our
implementation:
- Daily summaries at 08:00 per channel timezone (from signals + extractions since last daily)
- Weekly summaries Monday 08:00 (from daily summaries, not raw signals)
- On-demand: "catch me up" generates immediately for last 24 h or since user's last message

The `summaries` table uses `scope_type` (channel | topic | project | person) for future
extensibility. MVP only uses `scope_type = 'channel'`.

### 5.8 Access Scoping

**Critical from §11.1**: Query responses must respect channel membership. Knowledge from
channel A must not be surfaced to users who are not members of channel A.

In practice: when a user asks a question in channel X, the retrieval scope is:
- `channel_id = X` for structured SQL and graph paths
- Org-wide ONLY for personal-mode queries (1:1 DM), filtered to user's own entities

Cross-channel retrieval is a post-MVP feature (§8.3).

### 5.9 Seven LLM Model Slots

| Slot | Default Model | Fallback | Env Var |
|---|---|---|---|
| classify | `qwen3-2507:4b` | `qwen3:0.6b` | `JEEVES_MODEL_CLASSIFY` |
| extract | `qwen3-2507:30b-a3b` | `qwen3:14b` | `JEEVES_MODEL_EXTRACT` |
| embed | `qwen3-embedding:4b` | `bge-m3:567m` | `JEEVES_MODEL_EMBED` |
| summarise | `qwen3-2507:30b-a3b` | `qwen3:14b` | `JEEVES_MODEL_SUMMARISE` |
| queryAnalyse | `granite4-tiny-h:7b` | `qwen3-2507:4b` | `JEEVES_MODEL_QUERY_ANALYSE` |
| respond | `qwen3-2507:30b-a3b` | `qwen3:14b` | `JEEVES_MODEL_RESPOND` |
| complexSynthesis | `qwen3-next:80b` | `qwen3-2507:30b-a3b` | `JEEVES_MODEL_COMPLEX` |

All slots share one provider base URL + API key (`JEEVES_LLM_BASE_URL`, `JEEVES_LLM_API_KEY`).
Fallback: retry once on 503/timeout, then use fallback model. Log both attempts.

---

## 6. Database Schema (Target)

### 6.1 channel_config (replaces ConversationConfig)

```sql
CREATE TABLE channel_config (
  channel_id          TEXT PRIMARY KEY,           -- "{convId}@{domain}"
  channel_name        TEXT,
  organisation_id     TEXT NOT NULL,              -- Wire domain, e.g. "wire.com"
  state               TEXT NOT NULL DEFAULT 'active',  -- active | paused | secure
  state_changed_at    TIMESTAMPTZ,
  state_changed_by    TEXT,                       -- Wire user ID
  purpose             TEXT,
  context_type        TEXT,                       -- customer | project | team | general
  tags                TEXT[],
  stakeholders        TEXT[],
  related_channels    TEXT[],
  context_updated_at  TIMESTAMPTZ,
  context_updated_by  TEXT,
  secure_ranges       JSONB DEFAULT '[]',          -- [{start, end}]
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  locale              TEXT NOT NULL DEFAULT 'en',
  joined_at           TIMESTAMPTZ DEFAULT now()
);
```

### 6.2 decisions (replaces Decision)

```sql
CREATE TABLE decisions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       TEXT NOT NULL,
  organisation_id  TEXT NOT NULL,
  summary          TEXT NOT NULL,
  rationale        TEXT,                          -- Why, synthesised from conversation
  decided_by       TEXT[],                        -- Participant IDs/names
  decided_at       TIMESTAMPTZ NOT NULL,          -- When the decision crystallised
  confidence       REAL DEFAULT 0.8,              -- LLM extraction confidence
  status           TEXT DEFAULT 'active',         -- active | superseded | reversed | questioned
  superseded_by    UUID REFERENCES decisions,
  tags             TEXT[],
  source_ref       JSONB NOT NULL,               -- {wire_msg_ids: [], timestamp_range: {}}
  extraction_model TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);
-- Indexes: (channel_id, decided_at DESC), GIN(tags), (status) WHERE status='active'
```

### 6.3 actions (replaces Action)

```sql
CREATE TABLE actions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        TEXT NOT NULL,
  organisation_id   TEXT NOT NULL,
  description       TEXT NOT NULL,
  owner_id          TEXT,                         -- Wire user ID
  owner_name        TEXT,                         -- Display name at extraction time
  deadline          TIMESTAMPTZ,
  status            TEXT DEFAULT 'open',          -- open | done | stale | cancelled
  staleness_at      TIMESTAMPTZ,                  -- When to flag if no update
  confidence        REAL DEFAULT 0.8,
  tags              TEXT[],
  source_ref        JSONB NOT NULL,
  related_decision  UUID REFERENCES decisions,
  created_at        TIMESTAMPTZ DEFAULT now(),
  last_status_check TIMESTAMPTZ
);
-- Indexes: (owner_id, status), (status, staleness_at) WHERE status='open', (channel_id, created_at DESC)
```

### 6.4 entities

```sql
CREATE TABLE entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      TEXT NOT NULL,
  organisation_id TEXT NOT NULL,
  entity_type     TEXT NOT NULL,   -- person | service | project | team | tool | concept
  name            TEXT NOT NULL,
  aliases         TEXT[],          -- alternate names for dedup/resolution
  metadata        JSONB DEFAULT '{}',
  first_seen      TIMESTAMPTZ,
  last_mentioned  TIMESTAMPTZ,
  mention_count   INTEGER DEFAULT 1,
  deleted         BOOLEAN DEFAULT FALSE
);
-- Indexes: (entity_type, name), GIN(aliases), (organisation_id, entity_type)
```

### 6.5 entity_relationships

```sql
CREATE TABLE entity_relationships (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         UUID REFERENCES entities NOT NULL,
  target_id         UUID REFERENCES entities NOT NULL,
  relationship      TEXT NOT NULL,  -- owns | depends_on | works_on | blocks | reports_to
  context           TEXT,           -- Brief synthesised explanation
  confidence        REAL DEFAULT 0.7,
  first_observed    TIMESTAMPTZ,
  last_observed     TIMESTAMPTZ,
  observation_count INTEGER DEFAULT 1,  -- Strengthens with repetition
  source_ref        JSONB,
  UNIQUE(source_id, target_id, relationship)
);
-- Indexes: (source_id, relationship), (target_id, relationship)
```

### 6.6 embeddings (Layer 4 — separate from entities)

```sql
CREATE TABLE embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,         -- decision | action | signal | summary | message
  source_id   UUID,                  -- References source record if applicable
  channel_id  TEXT NOT NULL,
  organisation_id TEXT NOT NULL,
  author_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL,  -- When source content occurred (NOT when embedded)
  topic_tags  TEXT[],
  embedding   vector(1024)           -- Dimension from JEEVES_EMBED_DIMS, default 1024
);
-- Indexes: HNSW on embedding, (channel_id, created_at DESC), (source_type, source_id), GIN(topic_tags)
```

### 6.7 conversation_signals

```sql
CREATE TABLE conversation_signals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       TEXT NOT NULL,
  organisation_id  TEXT NOT NULL,
  signal_type      TEXT NOT NULL,  -- discussion | question | blocker | update | concern
  summary          TEXT NOT NULL,  -- 1-2 sentence synthesised note (NO verbatim content)
  participants     TEXT[],
  tags             TEXT[],
  related_entities UUID[],         -- Links to entities table
  occurred_at      TIMESTAMPTZ NOT NULL,
  confidence       REAL DEFAULT 0.6,
  source_ref       JSONB NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now()
);
-- Indexes: (channel_id, occurred_at DESC), (signal_type, occurred_at DESC), GIN(tags)
```

### 6.8 summaries

```sql
CREATE TABLE summaries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type     TEXT NOT NULL,   -- channel | topic | project | person
  scope_id       TEXT NOT NULL,   -- channel_id or entity name
  organisation_id TEXT NOT NULL,
  period_start   TIMESTAMPTZ NOT NULL,
  period_end     TIMESTAMPTZ NOT NULL,
  granularity    TEXT NOT NULL,   -- daily | weekly | on_demand
  summary        TEXT NOT NULL,   -- Synthesised, NO verbatim quotes
  key_decisions  UUID[],          -- References to decisions
  key_actions    UUID[],          -- References to actions
  active_topics  UUID[],
  participants   TEXT[],
  sentiment      TEXT,            -- productive | contentious | blocked | routine
  message_count  INTEGER,
  model_version  TEXT,
  generated_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (scope_type, scope_id, granularity, period_start)
);
```

### 6.9 Existing Tables: Minimal Changes

**Task, Reminder**: Add `source_ref JSONB`, add `organisation_id TEXT`; remove `rawMessage`.
Keep `rawMessageId` → rename to first entry in `source_ref.wire_msg_ids`.

**AuditLog**: Add `organisation_id TEXT`.

**EntityIdSequence**: Keep as-is (used for friendly IDs like DEC-0001).

**KnowledgeEntry**: **Drop entirely** — replaced by `entities` + `embeddings`.

### 6.10 Migration Order

Phase 1a migrations (additive — no drops):
1. Add `organisation_id TEXT` (nullable) to all existing tables; backfill from `conversationDom`
2. Add `source_ref JSONB` (nullable) to existing tables; populate from `rawMessageId`
3. Add `decided_at TIMESTAMPTZ` to `Decision`; backfill from `timestamp`
4. Add `rationale`, `decided_by TEXT[]`, `confidence REAL`, `extraction_model TEXT` to `Decision`
5. Add `staleness_at`, `last_status_check`, `confidence`, `related_decision` to `Action`
6. Create `channel_config`; migrate data from `ConversationConfig` (keep `ConversationConfig` for now)
7. Create `entities`, `entity_relationships`, `embeddings`, `conversation_signals`, `summaries`

Phase 1b migrations (drops — run after all use-cases removed):
8. Drop `rawMessage` columns from all tables
9. Migrate `Task` records → `actions`; drop `Task` table
10. Drop `ConversationConfig` table
11. Drop `KnowledgeEntry` table
12. Make `organisation_id` NOT NULL across all tables
13. Add HNSW index on `embeddings.embedding`

### 6.11 Migration Data Notes

**`source_ref` backfill** (Phase 1a migration):
```sql
-- Populate source_ref from rawMessageId on all tables that have it
UPDATE decisions
SET source_ref = jsonb_build_object(
  'wire_msg_ids', jsonb_build_array("rawMessageId"),
  'timestamp_range', jsonb_build_object('start', timestamp, 'end', timestamp)
)
WHERE source_ref IS NULL AND "rawMessageId" IS NOT NULL;
-- Repeat for actions, tasks (before task drop)
```

**`decided_at` backfill** (Phase 1a migration on `Decision`):
```sql
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
UPDATE "Decision" SET decided_at = timestamp WHERE decided_at IS NULL;
```

**`channel_name` storage**: On `onAppAddedToConversation(conversation, members)`, upsert a
`channel_config` row with `channel_name = conversation.name`, `joined_at = now()`. On
`onUserJoinedConversation` / `onUserLeftConversation`, update the `memberCache` in memory and
re-compute the `personal_mode` flag (is_1_to_1) and store it on `channel_config`.

---

## 7. Environment Variables (Spec-Aligned Naming)

```bash
# LLM Provider (single provider for all slots)
JEEVES_LLM_BASE_URL=https://api.cloudtemple.example.com/v1
JEEVES_LLM_API_KEY=ct_sk_...
JEEVES_LLM_TIMEOUT_MS=60000

# Model assignments (per slot)
JEEVES_MODEL_CLASSIFY=qwen3-2507:4b
JEEVES_MODEL_EXTRACT=qwen3-2507:30b-a3b
JEEVES_MODEL_EMBED=qwen3-embedding:4b
JEEVES_MODEL_SUMMARISE=qwen3-2507:30b-a3b
JEEVES_MODEL_QUERY_ANALYSE=granite4-tiny-h:7b
JEEVES_MODEL_RESPOND=qwen3-2507:30b-a3b
JEEVES_MODEL_COMPLEX=qwen3-next:80b

# Model fallbacks (per slot)
JEEVES_FALLBACK_CLASSIFY=qwen3:0.6b
JEEVES_FALLBACK_EXTRACT=qwen3:14b
JEEVES_FALLBACK_EMBED=bge-m3:567m
JEEVES_FALLBACK_SUMMARISE=qwen3:14b
JEEVES_FALLBACK_QUERY_ANALYSE=qwen3-2507:4b
JEEVES_FALLBACK_RESPOND=qwen3:14b
JEEVES_FALLBACK_COMPLEX=qwen3-2507:30b-a3b

# Thresholds
JEEVES_EXTRACT_CONFIDENCE_MIN=0.6      # Min confidence to persist extraction
JEEVES_COMPLEXITY_THRESHOLD=0.7        # When to escalate to complexSynthesis
JEEVES_ENTITY_DEDUP_THRESHOLD=0.92     # Cosine similarity for entity dedup
JEEVES_CONTRADICTION_THRESHOLD=0.78   # Cosine similarity for contradiction detection

# Embedding
JEEVES_EMBED_DIMS=1024                 # Adjust to 1536 if qwen3-embedding:4b confirms that

# Redis / BullMQ — deferred to horizontal-scaling milestone
# REDIS_URL=redis://redis:6379

# Existing vars kept for backwards compat (aliased in LLMConfigAdapter)
LLM_PASSIVE_BASE_URL=  # -> JEEVES_LLM_BASE_URL
LLM_CAPABLE_BASE_URL=  # -> JEEVES_LLM_BASE_URL
```

---

## 8. New/Changed Application Ports

```typescript
// application/ports/ClassifierPort.ts
interface ClassifyResult {
  categories: string[];       // multiple categories possible
  confidence: number;
  entities: string[];         // named entities mentioned
  is_high_signal: boolean;
}
interface ClassifierPort {
  classify(text: string, channelContext: ChannelContext, window: string[]): Promise<ClassifyResult>;
}

// application/ports/ExtractionPort.ts
interface ExtractResult {
  decisions: ExtractedDecision[];
  actions: ExtractedAction[];
  entities: ExtractedEntity[];
  signals: ExtractedSignal[];
}
interface ExtractionPort {
  extract(window: WindowMessage[], channelContext: ChannelContext,
          knownEntities: string[]): Promise<ExtractResult>;
}

// application/ports/EmbeddingPort.ts (extend existing)
interface EmbeddingPort {
  embed(text: string): Promise<number[]>;  // text discarded by caller after this returns
}

// application/ports/SummarisationPort.ts
interface SummarisationPort {
  summarise(signals: ConversationSignal[], decisions: Decision[], actions: Action[],
            priorSummary: string | null, granularity: 'daily'|'weekly'|'on_demand'): Promise<SummaryResult>;
}

// application/ports/QueryAnalysisPort.ts
interface QueryPlan {
  intent: 'factual_recall'|'temporal_context'|'cross_channel'|'accountability'|'institutional'|'dependency';
  entities: string[];
  timeRange: { start?: Date; end?: Date } | null;
  channels: string[] | null;
  paths: Array<{ path: 'structured'|'semantic'|'graph'|'summary'; params: Record<string, unknown> }>;
  responseFormat: 'direct_answer'|'summary'|'list'|'comparison';
}
interface QueryAnalysisPort {
  analyse(question: string, channelContext: ChannelContext, members: MemberContext[]): Promise<QueryPlan>;
}

// application/ports/RetrievalPort.ts
interface RetrievalResult {
  id: string;
  type: 'decision'|'action'|'entity'|'signal'|'summary';
  content: string;        // Synthesised, no verbatim text
  sourceChannel: string;
  sourceDate: Date;
  confidence: number;
  pathsMatched: string[];  // which retrieval paths found this (for multi-path boost)
}
interface RetrievalPort {
  retrieve(plan: QueryPlan, scope: RetrievalScope): Promise<RetrievalResult[]>;
}
interface RetrievalScope {
  organisationId: string;
  channelId?: string;     // undefined = post-MVP cross-channel
  userId?: string;        // defined in personal 1:1 mode
}
```

---

## 9. New Infrastructure Components

| File | Role |
|---|---|
| `infrastructure/queue/InMemoryProcessingQueue.ts` | Concurrency-limited async worker pool (max 5); replaces BullMQ at MVP |
| `infrastructure/llm/OpenAIClassifierAdapter.ts` | Tier 1 (refactor from ConversationIntelligenceAdapter) |
| `infrastructure/llm/OpenAIExtractionAdapter.ts` | Tier 2 — uses sliding window + channel context |
| `infrastructure/llm/OpenAISummarisationAdapter.ts` | Daily/weekly/on-demand summaries |
| `infrastructure/llm/OpenAIQueryAnalysisAdapter.ts` | Pre-retrieval query planning |
| `infrastructure/llm/LLMClientFactory.ts` | Single OpenAI client with fallback chain support |
| `infrastructure/persistence/postgres/PrismaChannelConfigRepository.ts` | Replaces PrismaConversationConfigRepository |
| `infrastructure/persistence/postgres/PrismaDecisionRepository.ts` | Update to new schema |
| `infrastructure/persistence/postgres/PrismaActionRepository.ts` | Update to new schema |
| `infrastructure/persistence/postgres/PrismaEntityRepository.ts` | New: entity + relationship CRUD + dedup |
| `infrastructure/persistence/postgres/PrismaEmbeddingRepository.ts` | New: standalone embeddings table |
| `infrastructure/persistence/postgres/PrismaConversationSignalRepository.ts` | New |
| `infrastructure/persistence/postgres/PrismaConversationSummaryRepository.ts` | New |
| `infrastructure/retrieval/MultiPathRetrievalEngine.ts` | Orchestrates 4 paths, merges via weighted RRF |
| `infrastructure/retrieval/StructuredRetrievalPath.ts` | SQL: decisions/actions by filters |
| `infrastructure/retrieval/SemanticRetrievalPath.ts` | pgvector HNSW on embeddings table |
| `infrastructure/retrieval/GraphRetrievalPath.ts` | BFS on entity_relationships |
| `infrastructure/retrieval/SummaryRetrievalPath.ts` | Fetch matching ConversationSummary |
| `infrastructure/buffer/SlidingWindowBuffer.ts` | In-memory ring buffer per channel (max 30 msgs) |

---

## 10. Result Merging Algorithm (Spec §6.3)

1. **Deduplicate**: same record from multiple paths → one entry
2. **Multi-path boost**: found by ≥ 2 paths → 1.5× relevance multiplier
3. **Recency weighting**: configurable decay rate, more recent = higher
4. **Confidence weighting**: extraction confidence > 0.8 outranks lower
5. **Token budget**: cap total context at 6,000–8,000 tokens for generation call
6. Return top-k results ordered by final score

---

## 11. Response Generation (Spec §6.4)

Context injected into LLM prompt in this order:

```
## Relevant Decisions
{decision records: summary, decided_by, decided_at, channel, source_ref}

## Relevant Actions
{action records: description, owner, deadline, status}

## Related Context
{conversation signals, entity relationships}

## Summaries
{relevant rolling summaries}

## User's Question
{question}
```

Jeeves persona rules (spec §7.1):
- Never use exclamation marks
- "I'm afraid" not "Sorry"
- "Shall I" not "Do you want me to"
- "One notes that" when diplomatically pointing out issues
- When citing: reference channel + approximate date, NOT verbatim quotes
- Cannot find → "I'm afraid I have no record of that particular matter."
- Contradiction → "One notes that this appears to differ from..."

---

## 12. Proactive Behaviours

### 12.1 Staleness Detection (spec §8.1)

Run twice daily via InProcessScheduler:

```sql
SELECT * FROM actions
WHERE status = 'open'
AND (deadline < now() OR staleness_at < now())
AND last_status_check < now() - interval '24 hours'
ORDER BY COALESCE(deadline, staleness_at) ASC;
```

Response: "If I may, Tom undertook to complete the API review by Friday. That was four days
ago and I haven't noted any subsequent update. Shall I mark this as still in progress, or has it
been resolved?"

### 12.2 Decision Contradiction Detection (spec §8.2)

After each decision is extracted:
1. pgvector similarity search against active decisions in same channel, past 90 days
2. Candidates with similarity ≥ `JEEVES_CONTRADICTION_THRESHOLD` (0.78) = "same topic"
3. For each candidate, classify model asks: "Does decision B contradict decision A? Answer yes or no."
4. If yes and both > 30 min old: flag in channel
5. User can `supersede_decision` or `dismiss_contradiction`

### 12.3 Cross-Channel Awareness (Post-MVP, spec §8.3)

Entity graph + topic tagging already supports this. Not in MVP scope.

---

## 13. WireEventRouter Refactor

```
WireEventRouter          — thin Wire SDK event handler
    │
    ├─► onTextMessage    → check channel state → if ACTIVE: enqueue to InMemoryProcessingQueue; if @mention: CommandRouter
    ├─► onButtonAction   → CommandRouter (existing button handling)
    ├─► onMemberJoined   → update memberCache; if 0 members → ask for channel purpose
    └─► onConversationDeleted → clear SlidingWindow for channel

InMemoryProcessingQueue (worker)
    │
    ├─► SlidingWindowBuffer.push(message)
    ├─► Tier1ClassifyStep  → ClassifierPort
    ├─► if is_high_signal: Tier2ExtractStep → ExtractionPort
    │       ├─► EntityRepository.upsertWithDedup()
    │       ├─► DecisionRepository.create()
    │       ├─► ActionRepository.create()
    │       └─► ConversationSignalRepository.create()
    └─► Tier3EmbedStep (async, fire-and-forget) → EmbeddingRepository.create()

CommandRouter
    ├─► pause / step out          → set PAUSED state
    ├─► resume / come back        → set ACTIVE state
    ├─► secure mode / ears off    → set SECURE + flush SlidingWindow
    ├─► context: ...              → SetContextCommand
    ├─► context type / tags / stakeholders → SetContextCommand
    ├─► catch me up / what did I miss → CatchMeUpCommand
    ├─► status                    → StatusCommand
    ├─► tasks / actions / decisions / knowledge (existing) → existing use-cases
    └─► {anything else}           → QueryAnalysis → MultiPathRetrieval → respond
```

---

## 14. New Commands

| Command | Use-case | Notes |
|---|---|---|
| `@Jeeves status` | `StatusCommand` | Channel state, how long active, entity counts, last summary date |
| `@Jeeves catch me up` / `what did I miss` | `CatchMeUpCommand` | On-demand: last 24h or since user's last msg |
| `@Jeeves pause` / `step out` | state → PAUSED | — |
| `@Jeeves resume` / `come back` | state → ACTIVE | — |
| `@Jeeves secure mode` / `ears off` | state → SECURE + flush | — |
| `@Jeeves context: <text>` | `SetContextCommand` | Set purpose |
| `@Jeeves context type: <type>` | `SetContextCommand` | Set contextType |
| `@Jeeves context tags: <tags>` | `SetContextCommand` | Set tags |
| `@Jeeves context stakeholders: <mentions>` | `SetContextCommand` | Set stakeholders |
| `@Jeeves context related: #channel` | `SetContextCommand` | Set relatedChannels |

---

## 15. Implementation Phases (Spec §10 Aligned)

### Phase 1a — Foundation: Schema Additions + Channel State Machine (Weeks 1–2)

Exit criteria: pause/resume/secure commands work in Jeeves voice. All existing tests still
pass. **No schema drops yet** — `ConversationConfig`, `rawMessage` columns, `KnowledgeEntry`,
and `Task` table all still present at end of 1a.

Tasks:
1. Implement `SlidingWindowBuffer` (in-memory ring buffer, max 30 msgs, flush on SECURE)
2. Implement `InMemoryProcessingQueue` (concurrency-limited async pool, max 5 concurrent, max depth 500, drop-oldest on overflow)
3. Prisma migration: add `organisation_id TEXT` (nullable) to all existing tables; backfill from `conversationDom`
4. Prisma migration: add `source_ref JSONB` (nullable) to existing tables; populate from `rawMessageId`; keep `rawMessageId` for now
5. Prisma migration: add `decided_at TIMESTAMPTZ` to `Decision`; backfill from `timestamp` column
6. Prisma migration: add `rationale`, `decided_by TEXT[]`, `confidence REAL` to `Decision`
7. Prisma migration: add `staleness_at`, `last_status_check`, `confidence`, `related_decision` to `Action`
8. Prisma migration: create new tables `channel_config`, `entities`, `entity_relationships`, `embeddings`, `conversation_signals`, `summaries`
9. Prisma migration: migrate data from `ConversationConfig` → `channel_config` (including `channel_name` from `onAppAddedToConversation` events going forward); do NOT drop `ConversationConfig` yet
10. Implement `PrismaChannelConfigRepository` (state machine, context, secure_ranges, joined_at, timezone)
11. Handle `onAppAddedToConversation`: persist `channel_name` and `joined_at` in `channel_config`
12. Handle `onUserJoinedConversation` / `onUserLeftConversation`: update `memberCache`; re-evaluate personal mode flag
13. Refactor `WireEventRouter`: check `channel_config.state` before any processing
14. Implement pause/resume/secure commands with correct Jeeves-voice responses; flush `SlidingWindowBuffer` on SECURE
15. Implement `SetContextCommand` (purpose, type, tags, stakeholders, related)
16. Implement `LLMClientFactory` with per-slot model config and fallback chain support
17. Extend `LLMConfigAdapter` for `JEEVES_*` env vars; keep `LLM_PASSIVE_*` / `LLM_CAPABLE_*` as read-only aliases
18. All existing tests still pass

Gate: `ConversationConfig` still exists; existing test suite green.

### Phase 1b — Schema Drops + Task Retirement + KnowledgeEntry Removal (Weeks 2–3)

Exit criteria: no references to `rawMessage`, `Task`/`KnowledgeEntry` tables in application
code. All tests updated and passing.

Tasks:
1. Prisma migration: drop `rawMessage` columns from all tables (source_ref already populated in 1a)
2. Prisma migration: migrate `Task` records to `actions` (map fields; dev data may be dropped)
3. Prisma migration: drop `Task` table and `ConversationConfig` table
4. Prisma migration: drop `KnowledgeEntry` table (no FK dependencies after use-case deletion)
5. Prisma migration: make `organisation_id` NOT NULL across all tables
6. Prisma migration: add HNSW index on `embeddings.embedding`
7. Delete all 7 `src/application/usecases/knowledge/` use-case files
8. Delete `PrismaKnowledgeRepository.ts`; replace `PrismaConversationConfigRepository.ts` with `PrismaChannelConfigRepository.ts` (already written in 1a)
9. Delete all 7 Task use-case files (`CreateTaskFromExplicit`, `UpdateTask`, etc.)
10. Delete `PrismaTaskRepository.ts`
11. Remove specific button handler implementations (confirm_task, confirm_decision, confirm_action, confirm_knowledge); retain `CompositeMessage` + `onButtonActionReceived` dispatch infrastructure
12. Remove `OverdueNudgeService` (replaced by staleness detection scheduled job in Phase 4)
13. Remove `WeeklyDigestService` (replaced by `GenerateSummary` use-case + scheduler in Phase 4)
14. Remove `PendingActionBuffer` (replaced by `InMemoryProcessingQueue` + Tier 2 extraction)
15. Update `container.ts`: wire all new components; remove retired ones
16. Update all contract tests; remove tests for deleted use-cases; add test for PAUSED/SECURE discard

Gate: no references to `rawMessage`/`Task`/`KnowledgeEntry`/`ConversationConfig` in source; full test suite green.

### Phase 2 — Intelligence: Classification + Extraction Pipeline (Weeks 3–4)

Exit criteria: decisions and actions extracted with >0.7 precision. Entity graph growing. No raw
message content in DB (verified by audit query: `SELECT count(*) FROM decisions WHERE source_ref IS NULL`).

Tasks:
1. Wire `InMemoryProcessingQueue` into message handler (already implemented in Phase 1)
2. Implement `OpenAIClassifierAdapter` (Tier 1; returns `categories[]`, `is_high_signal`, `entities[]`)
3. Implement `OpenAIExtractionAdapter` (Tier 2; sliding window context injection; NEVER verbatim)
4. Wire `SlidingWindowBuffer` into message flow; flush on SECURE
5. Implement `PrismaEntityRepository` with dedup logic (similarity ≥ 0.92 + alias match)
6. Implement `PrismaEmbeddingRepository`; Tier 3 async embed with text discard
7. Implement `PrismaDecisionRepository` (new schema: rationale, decided_by, confidence, source_ref)
8. Implement `PrismaActionRepository` (new schema: staleness_at, last_status_check, confidence)
9. Implement `PrismaConversationSignalRepository`
10. Detect personal mode (2-member conv) in CommandRouter; set `RetrievalScope.userId`
11. Contradiction detection post-decision-extract (two-step: similarity → classify)
12. Update contract tests for pipeline; add audit query test (no raw content)

### Phase 3 — Retrieval Engine (Weeks 5–6)

Exit criteria: Team can ask factual questions and get accurate Jeeves-voice answers with
channel + date source references.

Tasks:
1. Implement `OpenAIQueryAnalysisAdapter` (returns `QueryPlan` with paths, intent, entities)
2. Implement `StructuredRetrievalPath` (SQL decisions/actions by owner/status/date/tag; respects channel scope)
3. Implement `SemanticRetrievalPath` (pgvector HNSW on `embeddings` table)
4. Implement `GraphRetrievalPath` (BFS on `entity_relationships`, depth ≤ 3)
5. Implement `MultiPathRetrievalEngine` (orchestrate paths; weighted RRF; 1.5× multi-path boost; token budget)
6. Implement `LLMClientFactory` model escalation (`complexityThreshold` logic)
7. Update `AnswerQuestion` use-case to use `MultiPathRetrievalEngine`
8. Update `OpenAIGeneralAnswerAdapter` response prompt (spec §6.4 structure)
9. Implement `StatusCommand`
10. Access scoping: ensure retrieval never crosses channel boundary (except personal mode)
11. Update tests

### Phase 4 — Summaries + Proactive (Weeks 7–8)

Exit criteria: catch-me-up works reliably. Stale actions flagged. Summaries generate on
schedule.

Tasks:
1. Implement `OpenAISummarisationAdapter`
2. Implement `GenerateSummary` use-case (reads signals + decisions + actions for period)
3. InProcessScheduler: `daily_summary` at 08:00 per channel timezone; `weekly_summary` Mon 08:00
4. Implement `CatchMeUpCommand` (on-demand, generates if no recent summary, posts to channel)
5. Implement `SummaryRetrievalPath`; integrate into `MultiPathRetrievalEngine`
6. Implement staleness detection scheduled job (twice daily); proactive nudge in Jeeves voice
7. Inject most recent daily summary into LLM context automatically for relevant queries
8. Update contract tests for all new commands
9. Remove any remaining `LLM_PASSIVE_*` / `LLM_CAPABLE_*` remnants (or document as permanent aliases)

---

## 16. File Deletions / Renames

| Current | Action |
|---|---|
| `src/domain/services/ConversationIntelligenceService.ts` | Rename → `ClassifierService.ts` |
| `src/domain/services/ImplicitDetectionService.ts` | Delete (merged into ExtractionPort) |
| `src/infrastructure/llm/OpenAIConversationIntelligenceAdapter.ts` | Rename → `OpenAIClassifierAdapter.ts` |
| `src/infrastructure/llm/OpenAIImplicitDetectionAdapter.ts` | Delete |
| `src/infrastructure/llm/StubConversationIntelligenceAdapter.ts` | Rename → `StubClassifierAdapter.ts` |
| `src/infrastructure/llm/StubImplicitDetectionAdapter.ts` | Delete |
| `src/infrastructure/search/PrismaSearchAdapter.ts` | Rename → `SemanticRetrievalPath.ts`; retarget to `embeddings` table |
| `src/application/services/PendingActionBuffer.ts` | Delete (replaced by `InMemoryProcessingQueue` + Tier 2 extraction) |
| `src/application/usecases/knowledge/` (all 7 files) | Delete (KnowledgeEntry dropped; entity queries via `PrismaEntityRepository`) |
| `src/infrastructure/persistence/postgres/PrismaKnowledgeRepository.ts` | Delete |
| `src/infrastructure/persistence/postgres/PrismaConversationConfigRepository.ts` | Replace with `PrismaChannelConfigRepository.ts` |

---

## 17. Testing Strategy

### Unit Tests
- `SlidingWindowBuffer`: push, flush, max size, flush on SECURE
- `MultiPathRetrievalEngine`: merging, dedup, 1.5× boost, token budget
- Each retrieval path independently with mocked repos
- Entity dedup: high similarity → update, low → insert, alias match → merge
- Model fallback: 503 → retry → fallback model

### Contract Tests (existing style)
- All existing `WireEventRouter.contract.test.ts` tests preserved
- New: pipeline flow (classify → extract → signal), PAUSED discards, SECURE flushes
- New: context commands, catch-me-up, status, contradiction detection, personal mode
- Audit test: after processing a message, no raw content in DB

### Integration Tests
- Real Postgres (pgvector): embed → store → retrieve end-to-end
- Access scoping: entities from channel A not returned for channel B query

---

## 18. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| ORM stays Prisma while spec says Drizzle | Documented as intentional decision; schema is the contract, not the ORM |
| Redis deferred — InMemoryProcessingQueue has no durability | Acceptable: processing is intentionally transient. If the process restarts, the sliding window is lost anyway (desired). Add Redis when horizontal scaling is needed. |
| `qwen3-embedding:4b` dims unknown | Confirm dims before Phase 2 migration; `JEEVES_EMBED_DIMS` env var makes it configurable |
| Tier 2 extraction too slow for real-time | BullMQ queue decouples it from message receipt; users see no lag; extraction is async |
| Entity dedup false merges at 0.92 | Same-type filter narrows candidates; `aliases` array provides additional name-based matching |
| Cross-channel data leak in org-wide queries | Access scoping enforced in `MultiPathRetrievalEngine`; personal mode only exposes user's own entities |
| `KnowledgeEntry` drop loses existing data | Acceptable for MVP (dev data only); document in migration |
| `PendingActionBuffer` removal changes action capture UX | Tier 2 extraction replaces it with higher quality; maturity delay no longer needed when extraction is async |
| Sliding window lost on restart | Desired behaviour per spec; extraction quality degrades briefly after restart then recovers |
