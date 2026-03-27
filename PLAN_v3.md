# Jeeves v3.0 — Implementation Plan

> Branch: `v3.0-planning`
> Builds on: v2.0 (extract-and-forget architecture, multi-path retrieval, seven-slot LLM)
> Status: Planning — 2026-03-27

---

## 1. Executive Summary

v3.0 is a reliability and interaction quality upgrade. The core architecture (hexagonal ports/adapters, extract-and-forget, multi-path retrieval) is preserved. The focus is on three compounding problems observed in production use of v2.0:

1. **Structured data duplication** — decisions and actions are created multiple times from the same source due to dual explicit/implicit pipeline paths with no deduplication at write time.
2. **Language management fragility** — the regex-based command parser breaks on natural variations; local model JSON failures silently drop high-signal messages; assignee ambiguity causes hard errors rather than clarifying questions.
3. **Robotic correction UX** — users must memorise entity IDs and command syntax to fix mistakes; contradiction detection sends unanswered questions; extraction provides no feedback loop.

**v3.0 removes all structured command syntax.** Users interact with Jeeves in plain English only. No prefixes (`decision:`, `action:`), no entity IDs in bot-initiated messages, no command memorisation. Every `@Jeeves` message is classified by the LLM and routed to the appropriate tool. The background extraction pipeline remains the primary capture mechanism.

### Token Budget Rationale

Removing structured syntax adds LLM classification to every `@Jeeves` message. This is managed as follows:

- **Intent classification uses the `classify` slot** — the smallest, fastest model, not the extraction model
- **`@Jeeves` messages are a small fraction of channel traffic** — the background pipeline already processes every message through Tier 1 classification; this is additive on a small subset only
- **Deduplication savings offset the cost** — preventing 2–3 duplicate extractions per high-signal message saves ~2,500 tokens per prevented duplicate (Tier 2 extraction is expensive); at moderate channel volume this exceeds classification overhead
- **No retry waste** — Zod validation retries within the same API call; failed extractions no longer burn a full pipeline run
- **Tool definitions are fixed overhead** — ~600 tokens per respond turn, but respond turns are already the most expensive operation in the system

Net effect across a typical active channel: roughly token-neutral once deduplication savings are counted. The gain is reliability and user experience, not additional cost.

---

## 2. Resolved Design Decisions

| # | Question | Decision |
|---|---|---|
| 1 | LLM client & structured output | Replace `LLMClientFactory` raw fetch + JSON.parse with **Vercel AI SDK** + **Zod** schemas. Automatic validation retry on schema failure. Seven-slot model config preserved. |
| 2 | Job queue & scheduling | Replace `InMemoryProcessingQueue` + `InProcessScheduler` with **BullMQ** + Redis. Redis added as a compose service. Only `message_content` key TTL set to 60s to preserve extract-and-forget. |
| 3 | Memory & contradiction resolution | Replace custom `ContradictionDetector` with **mem0** (self-hosted). mem0 checks for conflicts on every write and resolves declaratively rather than sending an unanswered question. |
| 4 | Retrieval pipeline | Replace custom `MultiPathRetrievalEngine` (hand-coded RRF, manual boosts) with **LlamaIndex TypeScript** `QueryFusionRetriever` + `RouterQueryEngine`. |
| 5 | Re-ranking | Add **`@xenova/transformers` cross-encoder** (runs on-prem) to reorder retrieval results by true relevance before token budget cut. Eliminates silent truncation of relevant results. |
| 6 | Vector storage | Replace `pgvector` with **pgvecto.rs** (drop-in, faster HNSW, sparse vector support). No schema migration required — same pgvector API. |
| 7 | Respond path | Replace deterministic retrieve→prompt→respond with **tool-calling via Vercel AI SDK** on the respond path only. Background extraction pipeline remains deterministic. |
| 8 | Command parsing | **Remove all structured command syntax.** Every `@Jeeves` message is classified by the LLM using the `classify` slot. No prefixes, no IDs in user-facing interaction. Assignee ambiguity → clarifying question, not hard error. A minimal regex fast-path remains only for unambiguous operational commands (`@Jeeves pause`, `@Jeeves resume`, `@Jeeves secure`). |
| 9 | Deduplication at write | Add similarity check at decision/action write time (cosine ≥ 0.85 within same channel + 24h window → merge, not insert). Explicit commands flag messages so background pipeline skips them. |
| 10 | Extraction acknowledgment | When background pipeline extracts a decision or action implicitly, send a lightweight acknowledgment with a dismiss option. Dismissed items are marked `status: dismissed` not deleted. |
| 11 | ORM | Keep Prisma. No change from v2.0 decision. |
| 12 | Privacy model | Unchanged. Redis keys for message content have 60s TTL. mem0 self-hosted. Tool calls are structured writes, not raw text persistence. |
| 13 | Organisation seed context | A human-managed YAML file (`jeeves-seed.yaml`) mounted via Docker volume at startup. Seeded facts are marked `source: seed` and are immune to background extraction overwrite. Standing decisions cannot be auto-superseded by contradiction detection. |
| 14 | File handling | Lazy extraction. When a file is shared in channel, store metadata only (no download). Process only when a user explicitly asks. Extracted content follows extract-and-forget — never persisted. |

---

## 3. Component Map

### 3.1 What Changes

| Area | v2.0 Component | v3.0 Replacement | Primary Gain |
|---|---|---|---|
| LLM client | Custom `LLMClientFactory` (raw fetch) | **Vercel AI SDK** | Structured output + auto-retry; provider-agnostic |
| Structured extraction | Raw JSON parse in `OpenAI*Adapter` | **Zod schemas** via `generateObject()` | Extraction never silently drops due to malformed JSON |
| Job queue | `InMemoryProcessingQueue` | **BullMQ** | Jobs survive restarts; backpressure; dead-letter queue |
| Scheduling | `InProcessScheduler` (setTimeout) | **BullMQ** delayed jobs + cron | Reminders survive restarts; cron survives restarts |
| Contradiction detection | `ContradictionDetector` (async, unanswered) | **mem0** self-hosted | Automatic resolution on write; declarative user message |
| Retrieval orchestration | Custom `MultiPathRetrievalEngine` (hand-coded RRF) | **LlamaIndex TS** `QueryFusionRetriever` | Maintained RRF; accurate token counting; extensible |
| Re-ranking | None (silent truncation) | **`@xenova/transformers`** cross-encoder | Relevant results prioritised within token budget |
| Vector storage | pgvector | **pgvecto.rs** | Faster HNSW; sparse vector support for hybrid retrieval |
| Interactive respond | Deterministic retrieve→respond | **Tool calling** (Vercel AI SDK) | Natural language corrections; no ID memorisation |
| Command parsing | Regex cascade | **Intent-first LLM + regex fast-path** | Handles natural variations; ambiguity → clarifying question |

### 3.2 What Does Not Change

| Component | Reason |
|---|---|
| Hexagonal architecture (ports/adapters) | All replacements implement existing ports |
| Seven-slot model design | Mapped onto Vercel AI SDK providers |
| Extract-and-forget privacy model | Preserved; Redis TTL enforces it |
| Background extraction pipeline (Tier 1→2→3) | Remains deterministic; only JSON parsing layer changes |
| PostgreSQL + Prisma ORM | No change |
| pgvecto.rs schema | Drop-in; same `<=>` cosine operator |
| Wire SDK integration | No change |
| `chrono-node` date parsing | Already appropriate |
| Channel state machine (ACTIVE/PAUSED/SECURE) | No change |
| Entity deduplication (≥0.92 similarity) | No change |

---

## 4. New Workstreams (Not Covered by Component Upgrades)

### 4.1 Deduplication at Write Time

**Problem**: Decisions and actions are created twice — once by direct user instruction (tool call via intent classifier) and once by the background extraction pipeline seeing the same message. The 30-message sliding window compounds this: as new messages arrive, the same fact can be extracted multiple times from successive windows.

**Two thresholds, two layers** — these are distinct and must not be confused:
- **0.92 cosine similarity** — existing entity deduplication (persons, projects, teams). No change.
- **0.85 cosine similarity** — new decision/action write-time deduplication. Lower threshold because decision phrasing varies more than entity names.

**Fix**:

1. **Creation flagging**: When any entity creation tool call (`log_decision`, `log_action`) executes — whether triggered by intent classifier or respond path — store the Wire message ID in a short-lived Redis set (`jeeves:created:<channelId>`, TTL 30 min). The TTL is 30 min (not 5 min) to cover the full 30-message sliding window re-extraction window. The Tier 2 extractor checks this set before writing extracted decisions/actions from the same message.

2. **Write-time similarity check**: Before inserting any decision or action, query embeddings for cosine similarity ≥ 0.85 within the same channel and a 24-hour window. If a match exists, merge (update confidence and `source_ref`) rather than insert. This check applies to ALL creation paths — tool calls and background extraction alike.

3. **DB-level constraint**: Add a partial unique index on `(channel_id, content_hash)` where `content_hash` is SHA-256 of the normalised summary text. Catches exact duplicates that slip through the similarity check. `contentHash` is computed on all new records; existing records have it NULL (excluded from index via `WHERE content_hash IS NOT NULL`).

4. **Race condition guard**: Write-time similarity check and insert run in a single serializable transaction. Concurrent inserts of identical content rely on the DB-level unique index as the final safety net.

```
User directs Jeeves to log a decision (tool call)
  └─ Execute log_decision tool
  └─ Write-time similarity check (≥0.85, 24h) → merge if match
  └─ Insert or merge
  └─ Flag wire_msg_id in Redis (jeeves:created:<channelId>, TTL 30m)

Background pipeline processes same message
  └─ Check Redis flag → if flagged, skip decision/action write
  └─ Still writes ConversationSignal (lightweight, always useful)

Background pipeline (un-flagged high-signal message)
  └─ Tier 2 extraction runs
  └─ Write-time similarity check (≥0.85, 24h) → merge if match
  └─ Insert or merge + flag
```

### 4.2 Full Natural Language Routing (No Structured Commands)

**Problem**: The regex cascade breaks on natural language variations, produces hard errors on ambiguous input, and requires users to learn and remember command syntax. The structured prefix approach (`decision:`, `action:`) is fundamentally at odds with natural team communication.

**Fix**: Remove all structured command syntax. Replace the entire command routing layer with LLM-based intent classification.

**Stage 1 — Operational fast-path** (< 1ms, no LLM call):
Only three unambiguous operational state changes bypass LLM:
- `@Jeeves pause` / `step out`
- `@Jeeves resume`
- `@Jeeves secure` / `ears off`

Everything else — including all knowledge capture, corrections, questions, and list requests — goes to Stage 2.

**Stage 2 — Natural language classification** (all `@Jeeves` messages):

```ts
const intent = await generateObject({
  model: classifySlot,   // smallest/cheapest slot — not the extraction model
  schema: z.object({
    type: z.enum([
      'log_decision', 'log_action', 'create_reminder',
      'correct_decision', 'correct_action', 'complete_action',
      'reassign_action', 'question', 'list_actions', 'list_decisions',
      'list_reminders', 'cancel_reminder', 'unknown'
    ]),
    entities: z.object({
      assignee: z.string().optional(),
      deadline: z.string().optional(),
      subject: z.string().optional(),
      targetRef: z.string().optional(),   // human description, not ID
    }),
    confidence: z.number(),
    clarificationNeeded: z.boolean(),
    clarificationPrompt: z.string().optional(),
  }),
  prompt: intentClassificationPrompt(message, recentContext),
})
```

**Examples of what this enables**:

| User says | Intent classified | Action |
|---|---|---|
| "We've decided to go with Postgres" | `log_decision` | Logs decision, sends acknowledgment |
| "Can Mike pick up the auth work?" | `log_action` | Creates action for Mike |
| "Actually that should be Sarah not Mike" | `correct_action` | Tool call: `reassign_action` |
| "That's done, we shipped yesterday" | `complete_action` | Tool call: `complete_action` with note |
| "Remind me Friday about the deploy" | `create_reminder` | Tool call: `create_reminder` |
| "What did we decide about the database?" | `question` | Full retrieval + respond path |
| "What's on my plate this week?" | `list_actions` | Structured query, formatted response |

If `clarificationNeeded: true`, Jeeves asks before acting. Assignee ambiguity ("which Sarah?") → clarifying question, not an error.

**Token cost**: The `classify` slot uses the smallest model. A classification call is ~300–400 tokens in, ~80 tokens out. This applies only to `@Jeeves`-directed messages, a small fraction of channel traffic.

---

## 5. Interaction Model Changes

### 5.1 Tool Calling on the Respond Path

The `respond` LLM slot gains tools. The extraction pipeline remains deterministic. Tool calling applies only when Jeeves is responding to a direct `@Jeeves` message — never from the background pipeline.

**Authorization: all tools are scoped to the requesting user's channel and organisation.** The tool execution layer (not the LLM) enforces this — every tool call receives an implicit `{ channelId, orgId, requestingUserId }` context injected server-side. The LLM cannot override or supply these values. Mutation tools validate that the target record belongs to the current channel before executing.

**Audit trail: every mutation tool call writes to `AuditLog`** with `{ tool, params, requestingUserId, channelId, timestamp, outcome }`. This is the only way to trace LLM-driven changes and is required for the Undo flow.

**Tools exposed to the respond LLM** (search tools return human-readable results; mutation tools take the internal ID resolved by a prior search):

```ts
// Read tools — scoped to current channel + org
search_decisions:   { query: string, filters?: { owner?, dateRange?, tags? } }
search_actions:     { query: string, filters?: { assignee?, status?, dateRange? } }
get_entity:         { name: string }

// Mutation tools — server enforces channel/org scope; all logged to AuditLog
log_decision:       { summary: string, decidedBy?: string[] }
log_action:         { description: string, assignee?: string, deadline?: string }
correct_decision:   { id: string, correction: string, reason?: string }
complete_action:    { id: string, completionNote?: string }
reassign_action:    { id: string, to: string }
update_deadline:    { id: string, deadline: string }
create_reminder:    { description: string, triggerAt: string, targetUserId?: string }
supersede_decision: { id: string, newSummary: string, reason?: string }
```

**Resolution pattern**: the LLM always calls a search tool first, selects the best match from results, then calls the mutation. Users never supply IDs. If the search returns multiple plausible matches, Jeeves asks for clarification before mutating.

**Input validation**: all string parameters on mutation tools are validated server-side (max length, no control characters) before passing to DB queries. `targetRef` is never used directly in SQL — it is a human description for LLM use only; the resolved internal ID is used for DB operations.

**Correction flows enabled**:

| User says | Tools called |
|---|---|
| "Actually that was Sarah's call" | `search_decisions(...)` → `correct_decision(...)` |
| "Mark the auth work as done — we shipped it" | `search_actions(...)` → `complete_action(...)` |
| "Remind me about this next Monday" | `create_reminder(...)` |
| "That action should be Mike's not John's" | `search_actions(...)` → `reassign_action(...)` |
| "What did we agree on for the API design?" | `search_decisions(...)` → answer |

**Ambiguous tool resolution** (multiple matches, unclear which): Jeeves asks "I found three actions matching 'auth work' — do you mean the API auth task assigned to Mike, the OAuth integration assigned to Sarah, or the session token work assigned to the platform team?" before calling any mutation.

### 5.2 Extraction Acknowledgment Loop

When the background pipeline extracts a decision or action implicitly, Jeeves sends a lightweight acknowledgment. **No internal IDs appear in this message.**

```
Jeeves: Noted — I've logged a decision: "we're moving to React".
        Correct it  |  Dismiss
```

- **Correct it** → opens a tool-calling respond turn pre-seeded with the decision context (Phase 3)
- **Dismiss** → marks `status: dismissed` and sets `dismissedAt`; excluded from all future retrieval. Any channel member may dismiss. Dismiss is idempotent.
- **No action** → decision stands; buttons expire after Wire SDK button timeout (~60s)

`dismissedAt` is an audit field — it records when and implicitly who (last actor in channel) dismissed the item. `status: dismissed` drives retrieval exclusion. Both fields are set together on dismiss; they are not independent states.

### 5.3 Contradiction Resolution

Replaces the current "One notes that... Shall I mark as superseded?" (unanswered question). Resolution is declarative and immediate. **No internal IDs appear in the message.**

```
Jeeves: I've updated the earlier decision on database choice — the current position
        is PostgreSQL, agreed on Tuesday. The earlier MySQL decision has been
        marked superseded.
        Undo
```

- **Undo** reverses the supersession: restores the earlier decision to `active` and removes the superseded link. Undo is available for 5 minutes after the resolution message (enforced server-side by comparing `AuditLog.timestamp`; the button becomes no-op after this window). Any channel member may undo — this is a deliberate team-level operation.
- Resolution is atomic: both the supersession write and the audit log entry are committed in a single transaction. If the transaction fails, the message is not sent and no partial state is written.

### 5.4 Human-Readable References in All Responses

Entity IDs (`DEC-42`, `ACT-15`) are retained internally for audit trail and deduplication but **never appear in any user-facing message** — not in confirmations, corrections, lists, or answers. Jeeves refers to "the React decision" or "Sarah's auth PR review" exclusively. Internal IDs are an implementation detail.

### 5.5 Correction Echoes Context

When a correction is made, the response shows before/after. **No internal IDs appear.**

```
Before: "Done — the auth work is now assigned to Sarah."
After:  "Done — I've moved the auth work from Mike to Sarah."

Before: "Decision revoked."
After:  "Done — I've removed the earlier decision to use MySQL.
         The current position is PostgreSQL, agreed last Tuesday."
```

---

## 6. New Features

### 6.1 Organisation Seed Context

Teams have standing knowledge that predates Jeeves: architectural decisions, key people, terminology, standing policies. Without seeding, Jeeves starts blind and takes weeks to build useful context from channel observation alone.

**Design**: A human-managed YAML file (`jeeves-seed.yaml`) that operators maintain alongside `docker-compose.yml`. Mounted read-only into the container. Loaded and upserted on every startup — idempotent.

**File format**:

```yaml
# jeeves-seed.yaml — Organisation context for Jeeves
# Edit this file and restart the bot to update seeded knowledge.
# Changes are idempotent — no duplicates created on restart.
version: 1

organisation:
  name: "Acme Engineering"
  description: "50-person SaaS company building B2B analytics tools"
  timezone: "Europe/London"

# People — aids name disambiguation and attribution
people:
  - name: "Alice Chen"
    aliases: ["Alice", "AC"]
    role: "CTO"
  - name: "Bob Smith"
    aliases: ["Bob"]
    role: "Engineering Manager"

# Standing decisions — permanent org policy, never auto-superseded
decisions:
  - summary: "PostgreSQL is our primary data store"
    tags: ["infrastructure", "database"]
  - summary: "All production deployments require two engineer sign-offs"
    tags: ["process", "deployment"]

# Glossary — helps Jeeves understand org-specific terminology
terminology:
  - term: "MRR"
    definition: "Monthly Recurring Revenue — our primary business metric"
  - term: "PDR"
    definition: "Product Design Review — weekly Thursday meeting"
```

**Docker Compose**:
```yaml
services:
  jeeves:
    volumes:
      - ./jeeves-seed.yaml:/jeeves/seed.yaml:ro
    environment:
      JEEVES_SEED_FILE: /jeeves/seed.yaml  # unset = no seeding, no error
```

**Startup behaviour**:
1. If `JEEVES_SEED_FILE` is unset, skip silently.
2. Parse and validate YAML. On schema error, log clearly and abort startup (do not start with partial seed).
3. Upsert all entities into Prisma with `source: 'seed'` and `orgId` from config.
4. Standing decisions are upserted with `standing: true` — the contradiction detector and background extraction pipeline skip them.
5. People are upserted into the Entity table with `type: 'person'` and aliases stored for disambiguation.
6. Terminology is upserted as `type: 'terminology'` entities — surfaced during query analysis to help interpret org-specific language.
7. On Phase 3+: seed facts are also pushed to mem0 on startup.

**Invariants**:
- Seeded decisions cannot be auto-superseded by background extraction or contradiction detection.
- Seeded people entities are candidates for assignee disambiguation but lower priority than channel-observed attributions.
- Re-running with the same file: no changes. Re-running with an updated file: modified entries updated, removed entries are NOT deleted (they may have been referenced by channel decisions — mark `source_note: 'removed_from_seed'` only).

**New Prisma fields**:
```prisma
// Add to Decision, Entity
source        String?   // 'seed' | 'extraction' | 'tool_call' | 'file:<filename>'
standing      Boolean   @default(false)  // true = immune to contradiction detection
sourceNote    String?   // human note e.g. 'removed_from_seed'
```

---

### 6.2 File Handling

Files shared in team channels often contain decisions, requirements, or context that should be available to Jeeves — but auto-processing every file would be expensive, potentially irrelevant, and privacy-invasive. The design is **lazy**: Jeeves is aware a file exists but processes it only when asked.

**Awareness on share**:
When Wire delivers a file attachment event:
```
Jeeves: I can see "Q1-roadmap.pdf" was shared by Alice. Ask me to summarise it
        or extract decisions from it whenever you're ready.
```
No download occurs. Only metadata is stored.

**Prisma model**:
```prisma
model SharedFile {
  id              String    @id @default(uuid())
  channelId       String
  orgId           String
  filename        String
  mimeType        String
  sharedBy        String    // Wire userId (opaque)
  sharedAt        DateTime
  wireAssetKey    String?   // Wire asset key — used for lazy download
  processedCount  Int       @default(0)
  lastProcessedAt DateTime?
  createdAt       DateTime  @default(now())

  @@index([channelId, sharedAt])
}
```

**On-demand processing** — triggered by user asking Jeeves about a file:

| User asks | Jeeves does |
|---|---|
| "Summarise that document" | Download → extract text → run `summarise` slot → return summary. Text discarded after response. |
| "What decisions are in the spec?" | Download → extract text → run extraction → present findings in chat. Text discarded. Nothing committed to memory unless user confirms. |
| "Remember the decisions from that doc" | Download → extract text → run extraction → commit to decisions table with `source: 'file:Q1-roadmap.pdf'`. Text discarded. |
| "What files have been shared this week?" | Query `SharedFile` table. No download needed. |

**Supported types** (Phase 1 of file handling):
- PDF → `pdf-parse`
- DOCX → `mammoth`
- TXT / MD → direct read

Unsupported type: `"I can see that file was shared but I'm afraid I can only read PDF, Word, and plain text files at the moment."`

**Privacy**:
- File content is never persisted. Downloaded into process memory, text extracted, source discarded immediately after processing.
- `wireAssetKey` stored in DB is an opaque Wire reference — not the file content.
- Wire file download uses the bot's existing authenticated Wire session.

**New port** (`src/application/ports/FileExtractorPort.ts`):
```ts
interface FileExtractorPort {
  extractText(assetKey: string, mimeType: string): Promise<string>
  isSupported(mimeType: string): boolean
}
```

**New use cases**:
- `AcknowledgeSharedFile` — stores metadata, sends awareness message
- `SummariseFile` — extract + summarise slot + respond
- `ExtractFromFile` — extract + present (with optional commit)

---

## 7. Component Boundaries

Clear division of responsibility between new components. These boundaries must not be blurred during implementation.

### mem0 — Write Path Only

mem0 is called **only on write** (when a new decision or action is created or updated). It is not in the retrieval hot path.

```
Decision created → mem0.add(extractedFact, metadata)
  └─ mem0 searches its store for contradictions
  └─ If contradiction found: mem0 merges/supersedes + returns resolution metadata
  └─ Jeeves sends declarative resolution message (§5.3)

mem0 stores: extracted entities only — summaries, rationale, assignees, timestamps
mem0 does NOT store: raw message text, Wire message IDs, sender identities
```

mem0's internal store is an **additional** persistence layer alongside Prisma/PostgreSQL. The Prisma schema remains the system of record for all structured data (decisions, actions, audit trail). mem0 is a conflict-detection index, not a replacement for the DB.

### LlamaIndex — Read Path Only

LlamaIndex is called **only on read** (when answering a question or resolving a tool search call).

```
User question → intent classifier → question intent
  └─ LlamaIndex RouterQueryEngine selects retrieval paths
  └─ QueryFusionRetriever runs selected paths + RRF merge
  └─ Cross-encoder re-ranker reorders results
  └─ Results passed to respond slot for answer generation

LlamaIndex queries: Prisma/PostgreSQL (structured), pgvecto.rs (semantic), entity graph, summaries
LlamaIndex does NOT: write to DB, call mem0, trigger extractions
```

**Integration point**: When mem0 supersedes a decision, the Prisma record is updated (`status: superseded`). LlamaIndex retrieval queries Prisma, so superseded decisions are automatically excluded from future retrieval without any LlamaIndex-specific integration needed.

### Summary

| Component | When called | Reads from | Writes to |
|---|---|---|---|
| mem0 | On every decision/action write | Its own internal store | Its own internal store |
| LlamaIndex | On every question/search | Prisma DB + pgvecto.rs | Nothing |
| Prisma | Always | PostgreSQL | PostgreSQL |
| BullMQ | On every message + scheduled jobs | Redis | Redis |
| cross-encoder | On every retrieval | LlamaIndex results | Nothing |

---

## 7. Failure Modes

Required fallback behaviour for each new component. All failures must be logged with structured context; none may crash the bot process.

| Scenario | Behaviour |
|---|---|
| Intent classifier times out (> 500ms) | Return `{ type: 'unknown' }` fallback; Jeeves responds "I'm not sure what you'd like — could you rephrase?" No retry. |
| Tool search returns multiple ambiguous matches | Jeeves asks clarifying question; does not call mutation tool until user disambiguates. |
| Mutation tool fails (DB error) | Jeeves responds "I wasn't able to make that change — please try again." AuditLog entry written with `outcome: failed`. |
| mem0 contradiction check fails | Log error; proceed with insert as if no contradiction. Do not block the write. |
| mem0 merge transaction fails | Log error; rollback to pre-merge state; do not send contradiction resolution message. |
| BullMQ job fails after max retries | Move to dead-letter queue; log with full job context; do not retry indefinitely. |
| BullMQ Redis unavailable on startup | Bot fails to start with a clear error. Redis is a hard dependency; no in-memory fallback. |
| cross-encoder model unavailable | Fall back to unranked LlamaIndex results; log warning; do not fail the query. |
| cross-encoder OOM / load failure | Same as above; alert via structured log. Pre-download model in Docker image to prevent cold-start failure (see §8). |
| Zod validation retries exhausted (Vercel AI SDK) | Log extraction failure with full prompt context; write `ConversationSignal` with `signal_type: discussion`, confidence 0.3. Do not surface error to user. |
| Undo button pressed after 5-minute window | Server-side check against AuditLog timestamp; respond "That change can no longer be undone." No-op on data. |
| Dismiss pressed on already-dismissed item | Idempotent no-op. No error. |

---

## 8. Security Requirements

### Redis

- Redis is internal to the Docker compose network. No external port exposed.
- Redis password authentication required (`REDIS_PASSWORD` env var). BullMQ configured with auth.
- Redis persistence **disabled** (`save ""`, `appendonly no` in redis.conf). Data survives only in memory — consistent with extract-and-forget. A Redis crash loses pending jobs (acceptable) but not message content (required).
- `message_content` keys: TTL 60s. Job payloads must not contain raw message text — only metadata (channelId, messageId, timestamp, signal type). Message text is read from the sliding window buffer in-process at job execution time, not stored in the job.
- Verify Redis TTL policy in staging before Phase 1 ships (moved from Open Question to requirement).

### Tool Calling Authorization

- All tool calls execute with server-injected scope `{ channelId, orgId, requestingUserId }`. The LLM cannot supply or override these values.
- Read tools (`search_decisions`, `search_actions`, `get_entity`) return only records scoped to `channelId` + `orgId`.
- Mutation tools validate target record `channelId` matches request `channelId` before executing. Cross-channel mutation returns an error, never silently operates.
- Rate limit: max 10 tool calls per `@Jeeves` turn; max 30 mutation tool calls per user per hour. Limits enforced in the tool execution layer, not by the LLM.

### Prompt Injection

- The background extraction pipeline **never triggers tool calls**. Only direct `@Jeeves` messages can invoke the intent classifier and tool path. A message saying "tell Jeeves to mark everything as done" received by the background pipeline is classified and extracted — it does not execute any tool.
- `targetRef` and all string parameters on intent classifier output are treated as human descriptions, never executed as queries directly. Resolved internal IDs come only from server-side search results.
- Max input length to intent classifier: 2,000 characters. Truncated cleanly at word boundary if exceeded.

### mem0 Privacy

- mem0 self-hosted instance is internal to the Docker compose network. No external port exposed.
- mem0 stores extracted entity summaries only — no raw message text, no Wire message IDs, no sender email or user ID beyond the Wire `userId.id` opaque identifier.
- mem0 data subject to same data deletion requirements as Prisma records. A "forget this channel" operation must purge mem0 entries for that channel alongside Prisma rows.

### @xenova/transformers

- Cross-encoder model files pre-downloaded and baked into the Docker image at build time. No runtime download. Model stored in `/app/models/` (Docker layer cached).
- Model loaded at bot startup (warm), not on first request (cold). Startup is slower; first retrieval is not.
- If model files are missing from the image, bot logs a clear error and disables re-ranking (falls back to unranked results). It does not attempt to download at runtime.

---

## 9. Schema Changes

Minimal — the core schema is stable. Additions only:

```prisma
// Add to Decision and Action models
dismissedAt   DateTime?         // set when user dismisses an extraction acknowledgment
contentHash   String?           // SHA-256 of normalised summary for dedup index
mergedIntoId  String?           // if this record was merged into another

// New: explicit message flag store (Redis, not Prisma)
// jeeves:explicit:<channelId> → Set<wireMessageId>, TTL 5m
```

**New partial unique index** (Prisma migration):
```sql
CREATE UNIQUE INDEX decision_content_hash_channel_idx
  ON decisions (channel_id, content_hash)
  WHERE content_hash IS NOT NULL AND status != 'dismissed';
```

---

## 10. Tool Maximisation

Each off-the-shelf component chosen for a specific reason. This section documents how to use each one to its full potential — not just as a drop-in replacement but extracting the value that motivated the choice.

### Vercel AI SDK (`ai`)

**Core pattern**: `generateObject()` for all structured LLM outputs, `generateText({ tools })` for the respond path.

```ts
// All LLM outputs use generateObject — never JSON.parse
const { object } = await generateObject({
  model: slots.extract,
  schema: ExtractionOutputSchema,   // Zod schema — auto-retried on validation failure
  prompt: buildExtractionPrompt(window, context),
})

// Respond path uses tool calling
const { text } = await generateText({
  model: slots.respond,
  tools: channelScopedTools(scope),
  maxSteps: 5,                      // cap agentic loop depth
  prompt: buildRespondPrompt(question, retrievedContext),
})
```

**What to use beyond the basics**:
- `experimental_telemetry`: emit per-call token usage as structured spans — feeds the token monitoring requirement from Phase 1
- `wrapLanguageModel`: add a logging middleware layer to every slot without touching each adapter
- Provider abstraction: all seven slots use `createOpenAICompatible()` — swapping model providers (Ollama → vLLM → Anthropic) requires changing only `src/app/config.ts`, not adapters
- `generateObject` retries: configure `maxRetries: 2` — on Zod validation failure the SDK re-prompts with the validation error, dramatically improving local model reliability

### Zod

**Core pattern**: schemas live in `src/domain/schemas/` and are the single source of truth for both TypeScript types and LLM output validation.

```ts
// src/domain/schemas/extraction.ts
export const DecisionSchema = z.object({
  summary: z.string().min(5).max(500),
  rationale: z.string().optional(),
  decidedBy: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()).default([]),
})
export type Decision = z.infer<typeof DecisionSchema>  // no separate type needed
```

**What to use beyond the basics**:
- `.transform()` for post-validation normalisation (lowercase tags, trim whitespace) — keeps data clean without extra code
- `.refine()` for cross-field rules (e.g., `standing: true` requires `source: 'seed'`)
- Discriminated unions for intent types: `z.discriminatedUnion('type', [...])` gives the classifier a closed set with no "catch-all" escape
- `z.infer` everywhere — eliminates duplicate type definitions between schemas and TypeScript interfaces

### BullMQ

**Core pattern**: three separate queues with different priorities and retry policies.

```ts
// Three queues — never mix concerns
const extractionQueue = new Queue('extraction', { connection })  // high priority, short TTL
const scheduledQueue  = new Queue('scheduled',  { connection })  // low priority, cron
const reminderQueue   = new Queue('reminders',  { connection })  // delayed jobs, user-facing
```

**What to use beyond the basics**:
- **Job deduplication**: `jobId: \`${channelId}:${messageId}\`` prevents double-processing if the same message is enqueued twice (e.g., bot restart during processing)
- **BullMQ Flows**: chain Tier1 → Tier2 → Tier3 as a parent/children flow — Tier3 embed only runs if Tier2 extract succeeds; failed flows are visible as a unit
- **Dead-letter queue**: failed jobs after max retries move to `dl-extraction` — inspectable without re-running, important for debugging local model failures
- **Job payloads**: contain only `{ channelId, messageId, timestamp }` — never message text. Text is read from the sliding window buffer in-process at execution time

### mem0 (self-hosted)

**Core pattern**: called on every decision/action write, not in the retrieval path.

```ts
// On decision creation
await mem0Client.add([{
  role: 'user',
  content: decision.summary,
}], {
  user_id: scope.channelId,          // scope per channel
  metadata: {
    type: 'decision',
    orgId: scope.orgId,
    confidence: decision.confidence,
    source: decision.source,
    standing: decision.standing,     // standing=true → skip contradiction check
  },
})
```

**What to use beyond the basics**:
- mem0's `search()` before writing — explicitly check for contradictions rather than relying on passive detection: gives control over the threshold and lets us suppress for standing decisions
- `metadata.standing: true` filter — exclude seeded standing decisions from contradiction candidates
- Configure mem0 to use the same Ollama embed endpoint as the `embed` slot — consistent vector space, no embedding drift between mem0's index and pgvecto.rs
- mem0's response includes `memories` that were updated/deleted — use this to drive the declarative contradiction message (§5.3), not a separate similarity search

### LlamaIndex TypeScript (`llamaindex`)

**Core pattern**: `RouterQueryEngine` selects retrievers per intent; `QueryFusionRetriever` runs and merges them.

```ts
const engine = new RouterQueryEngine({
  selector: new LLMSingleSelector({ llm: slots.queryAnalyse }),
  queryEngineTools: [
    { engine: structuredQueryEngine, description: "decisions and actions by filter" },
    { engine: semanticQueryEngine,   description: "semantic similarity search" },
    { engine: graphQueryEngine,      description: "entity relationships" },
    { engine: summaryQueryEngine,    description: "channel summaries" },
  ],
})
```

**What to use beyond the basics**:
- `QueryFusionRetriever` with `mode: RECIPROCAL_RERANK` — built-in RRF, replaces the hand-coded merge; configure `similarityTopK` and `numQueries` to tune recall vs. cost
- `SentenceTransformerRerank` (wrapping `@xenova/transformers`) as a post-retrieval step — reorders by cross-encoder score before token budget cut
- `TokenTextSplitter` for the token budget — accurate tiktoken-based counting, replaces the "4 chars per token" estimate
- LlamaIndex's `NodeParser` pipeline for file content in §6.2 — chunk documents into nodes before extraction, so "remember the decisions from that doc" works on large files without exceeding context window
- `MetadataFilter` on all retrievers — enforces `channelId` + `orgId` scope at the retrieval layer, not just in SQL

### pgvecto.rs

**Core pattern**: drop-in pgvector replacement — same `<=>` cosine operator, same SQL.

**What to use beyond the basics**:
- **Sparse vectors** (`svector`): add a sparse BM25-style vector alongside the dense embedding — hybrid dense+sparse retrieval in a single query, no separate keyword index needed
- **`halfvec`**: store 2560-dim qwen3-embedding:4b vectors as half-precision (saves ~50% storage, negligible quality loss)
- **HNSW tuning**: `m=16, ef_construction=64` — default is conservative; these values give better recall at the channel data scales expected
- **Indexing on `(org_id, embedding)`**: partition HNSW by org to avoid cross-org nearest-neighbour leakage at the vector layer (defence in depth alongside SQL scope)

### `@xenova/transformers` (cross-encoder)

**Model**: `cross-encoder/ms-marco-MiniLM-L-6-v2` — 22MB, good quality/size tradeoff, CPU-viable.

**What to use beyond the basics**:
- Pre-download in Dockerfile at build time — zero cold start:
  ```dockerfile
  RUN node -e "const {pipeline}=require('@xenova/transformers'); \
    pipeline('text-ranking','cross-encoder/ms-marco-MiniLM-L-6-v2')"
  ```
- Load at bot startup into a module-level singleton — one load, many uses
- Score threshold: discard results with cross-encoder score < -5 (raw logit scale) — prevents low-quality results from making the cut just because the initial retrieval was thin
- Run in a Node.js worker thread — keeps re-ranking off the main event loop, avoids latency spikes during heavy channel activity

---

## 11. New Dependencies

| Package | Purpose | Notes |
|---|---|---|
| `ai` (Vercel AI SDK) | LLM client, structured output, tool calling | Replaces custom fetch client |
| `zod` | Schema validation for all LLM outputs | Likely already transitive dep |
| `bullmq` | Job queue + scheduling | Replaces InMemoryProcessingQueue + InProcessScheduler |
| `ioredis` | Redis client for BullMQ | New |
| `mem0ai` | Write-path contradiction resolution | Self-hosted mode; Ollama-compatible |
| `llamaindex` | Retrieval pipeline orchestration | Replaces MultiPathRetrievalEngine |
| `@xenova/transformers` | Local cross-encoder re-ranker | Pre-downloaded in Docker image |
| `pgvecto.rs` | Postgres extension (docker image swap) | Drop-in for pgvector; adds sparse vectors |
| `js-yaml` | Parse `jeeves-seed.yaml` at startup | Seed context feature |
| `pdf-parse` | Extract text from PDF files | File handling feature |
| `mammoth` | Extract text from DOCX files | File handling feature |

**Removed dependencies** (or reduced to thin wrappers):
- Custom `LLMClientFactory` — deleted
- Custom `MultiPathRetrievalEngine` — deleted (replaced by LlamaIndex)
- Custom `ContradictionDetector` — deleted (replaced by mem0)
- Custom `InMemoryProcessingQueue` — deleted
- Custom `InProcessScheduler` — deleted

---

## 11. Phased Delivery

### Phase 1 — Reliability Foundation (~2 weeks)

Stop silent failures. Users can trust what the bot captures.

**Pre-requisite before starting**: Redis security configuration validated (no persistence, password auth, internal network only). This was previously an open question — it is now a hard gate.

- [ ] Add Redis compose service with persistence disabled, password auth, internal network only
- [ ] Replace `LLMClientFactory` with Vercel AI SDK
- [ ] Replace all `OpenAI*Adapter` JSON parsing with Zod `generateObject()` schemas
- [ ] Instrument per-slot token usage (structured log per LLM call: slot, model, tokens_in, tokens_out)
- [ ] Replace `InMemoryProcessingQueue` with BullMQ (job payloads contain no raw message text)
- [ ] Replace `InProcessScheduler` with BullMQ delayed jobs + cron
- [ ] Replace pgvector extension with pgvecto.rs (docker image swap + smoke test HNSW index)
- [ ] Implement `SeedLoader` — parse `jeeves-seed.yaml`, upsert decisions/entities/terminology with `source: 'seed'` and `standing: true` where applicable
- [ ] Add `JEEVES_SEED_FILE` env var; unset = skip silently; YAML schema error = abort startup
- [ ] Add `source`, `standing`, `sourceNote` fields to Decision and Entity (Prisma migration)
- [ ] All existing tests pass

**User-visible**: Extraction stops silently dropping messages on local model JSON errors. Reminders survive bot restarts. Bot starts with org context on day one.

---

### Phase 2 — Duplication & Deduplication (~2 weeks)

Stop the same fact appearing twice.

- [ ] Add `contentHash`, `dismissedAt`, `mergedIntoId` fields to Decision and Action (Prisma migration)
- [ ] Add partial unique index on `(channel_id, content_hash)` where `content_hash IS NOT NULL`
- [ ] Add write-time similarity check (≥0.85 cosine, 24h window, serializable transaction) before decision/action insert
- [ ] Add creation flagging (Redis set `jeeves:created:<channelId>`, TTL 30m) on all entity creation paths
- [ ] Tier 2 extractor checks creation flag before writing decisions/actions
- [ ] Tests: tool-call creation + background extraction from same message → single record
- [ ] Tests: similar decisions in 24h window → merged not duplicated
- [ ] Tests: race condition — concurrent inserts of identical content → unique index prevents duplicate

**Note**: Creation flagging in this phase covers existing explicit commands (still present). When Phase 3 removes explicit commands and replaces with tool calls, the same flagging mechanism applies — no Phase 2 code changes needed for Phase 3.

**User-visible**: "Why does Jeeves show the same decision three times?" is resolved.

---

### Phase 3 — Natural Language & Corrections (~3 weeks)

Users interact and correct in plain English. No structured commands.

- [ ] Remove all regex command handlers except operational fast-path (`pause`, `resume`, `secure`)
- [ ] Implement intent classifier (Vercel AI SDK `generateObject()` with Zod intent schema, `classify` slot)
- [ ] Implement tool execution layer with server-injected channel/org/user scope and rate limiting
- [ ] Implement all tools with input validation and AuditLog writes
- [ ] Implement ambiguous tool resolution — clarifying question when search returns multiple matches
- [ ] Replace `ContradictionDetector` with mem0 (self-hosted, internal network, Ollama-compatible endpoint confirmed)
- [ ] Implement extraction acknowledgment message (Correct it | Dismiss buttons)
- [ ] Implement contradiction resolution message (declarative + Undo, 5-minute window enforced via AuditLog)
- [ ] Wire button handlers for Undo, Correct it, Dismiss (idempotent)
- [ ] Tests: natural language intent classification covers all intent types
- [ ] Tests: tool authorization — cross-channel mutation is rejected
- [ ] Tests: rate limiting — 11th mutation tool call in an hour is rejected
- [ ] Tests: contradiction → single merged record + declarative message (no unanswered question)
- [ ] Tests: Undo after 5 minutes → no-op with message
- [ ] Implement `FileExtractorPort` + Wire file event handler (`AcknowledgeSharedFile`)
- [ ] Implement `SharedFile` Prisma model + migration
- [ ] Implement `SummariseFile` and `ExtractFromFile` use cases (pdf-parse, mammoth)
- [ ] File handling respects extract-and-forget (text discarded after processing)
- [ ] Tests: file shared → metadata stored, awareness message sent, no download
- [ ] Tests: "summarise that doc" → download, summarise, text discarded
- [ ] Tests: "remember decisions from that doc" → download, extract, commit with source ref

**User-visible**: No commands to learn. Corrections in plain English. Contradictions resolved automatically. Files handled on demand.

---

### Phase 4 — Retrieval Quality (~2 weeks)

Right answers, not first answers.

**Pre-requisite before starting**: `@xenova/transformers` model selected, size/memory validated, baked into Docker image.

- [ ] Pre-download cross-encoder model into Docker image at build time; load at startup
- [ ] Replace `MultiPathRetrievalEngine` with LlamaIndex TS `QueryFusionRetriever` (pgvecto.rs adapter)
- [ ] Implement `RouterQueryEngine` for intent-driven path selection
- [ ] Add cross-encoder re-ranker as post-retrieval step (fallback to unranked if model unavailable)
- [ ] Pass retrieval metadata (paths run, result count, threshold hits) into answer prompt
- [ ] Implement transparent "I don't have this because..." responses when retrieval returns nothing
- [ ] Tests: relevant result at rank 20 surfaces after re-ranking
- [ ] Tests: cross-encoder unavailable → unranked fallback, no query failure
- [ ] Tests: empty retrieval → transparent response with reason

**User-visible**: Fewer wrong answers. When Jeeves doesn't know something, it says why clearly.

---

### Phase 5 — Interaction Polish (~1 week)

Feel like a competent assistant.

- [ ] Audit all bot-initiated messages — remove any remaining internal IDs
- [ ] Correction responses echo before/after context in human-readable form
- [ ] Remove dead "Any actions from this?" button; replace with tool-backed follow-up prompts
- [ ] Contextual follow-ups: decision logged → offer review date or follow-up action; action completed → offer summary note; reminder fired → offer recurrence
- [ ] End-to-end interaction tests covering full natural language flows

**User-visible**: Responses feel conversational. Nothing looks like a command interface.

---

## 12. What Is Not In Scope for v3.0

| Item | Reason |
|---|---|
| MCP server | Separate capability (external client access); not internal architecture |
| Drizzle ORM migration | High effort, no user-facing gain |
| Horizontal scaling (multiple bot instances) | BullMQ makes this possible but it is a separate milestone |
| Cloud vector DB (Qdrant, Weaviate) | pgvecto.rs is sufficient; migration deferred |
| Streaming responses | Wire SDK does not support streaming message updates |
| GDPR/right-to-forget full implementation | Requires cross-system purge (Prisma + mem0 + pgvecto.rs). Scoped to a dedicated compliance milestone. |

---

## 13. Open Questions

| # | Question | Owner | Due |
|---|---|---|---|
| 1 | mem0 self-hosted: confirm Ollama-compatible embed endpoint support (not just OpenAI API) | Engineering | **Before Phase 3 starts** |
| 2 | `@xenova/transformers` cross-encoder: confirm model name, size, and memory footprint fit on-prem constraints | Engineering | **Before Phase 4 starts** |
| 3 | LlamaIndex TS: confirm pgvecto.rs vector store adapter exists or scope build cost if not | Engineering | **Before Phase 4 starts** |
| 4 | Intent classifier latency: measure classify slot response time on target hardware; must be < 500ms p95 | Engineering | **Before Phase 3 starts** |
| 5 | Token monitoring results from Phase 1: do deduplication savings in Phase 2 offset classification overhead? Share findings before Phase 3 scope is locked. | Engineering | End of Phase 2 |
