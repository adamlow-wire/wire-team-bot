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

**Problem**: Decisions and actions are created twice — once by explicit command and once by the background extraction pipeline seeing the same message. Additionally, the 30-message sliding window means facts can be extracted on successive messages.

**Fix**:

1. **Message flagging**: When an explicit command (`decision:`, `action:`) creates an entity, store the Wire message ID in a short-lived Redis set (`jeeves:explicit:<channelId>`, TTL 5 min). The Tier 2 extractor checks this set before writing extracted decisions/actions from the same message.

2. **Write-time similarity check**: Before inserting any decision or action, query embeddings for cosine similarity ≥ 0.85 within the same channel and a 24-hour window. If a match exists, merge (update the existing record's confidence and source_ref) rather than insert.

3. **DB-level constraint**: Add a partial unique index on `(channel_id, content_hash)` where `content_hash` is a SHA-256 of the normalised summary text. Catches exact duplicates that slip through the similarity check.

```
Explicit command fires
  └─ Create decision/action
  └─ Flag wire_msg_id in Redis (TTL 5m)
  └─ Write-time similarity check (≥0.85) → merge if match

Background pipeline sees same message
  └─ Check Redis flag → if flagged, skip decision/action write
  └─ Still writes ConversationSignal (lightweight, always useful)
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

The `respond` LLM slot gains tools. The extraction pipeline remains deterministic. Tool calling applies only when Jeeves is responding to a direct question or correction.

**Tools exposed to the respond LLM**:

```ts
tools: {
  search_decisions:   { query, filters: { owner?, dateRange?, tags? } },
  search_actions:     { query, filters: { assignee?, status?, dateRange? } },
  get_entity:         { name },
  correct_decision:   { id, correction, reason? },
  complete_action:    { id, completionNote? },
  reassign_action:    { id, to },
  update_deadline:    { id, deadline },
  create_reminder:    { description, triggerAt, targetId? },
  supersede_decision: { newSummary, supersedes },
}
```

The LLM resolves "the auth work" or "that decision about Postgres" to the correct internal record via `search_decisions` / `search_actions` before calling a mutation tool. Users never supply IDs.

**Correction flows enabled**:

| User says | Tools called |
|---|---|
| "Actually that was Sarah's call" | `search_decisions(...)` → `correct_decision(...)` |
| "Mark the auth work as done — we shipped it" | `search_actions(...)` → `complete_action(...)` |
| "Remind me about this next Monday" | `create_reminder(...)` |
| "That action should be Mike's not John's" | `search_actions(...)` → `reassign_action(...)` |
| "What did we agree on for the API design?" | `search_decisions(...)` → answer |

### 5.2 Extraction Acknowledgment Loop

When the background pipeline extracts a decision or action implicitly:

```
Jeeves: Noted — I've logged a decision: "we're moving to React" [DEC-43].
        Correct it  |  Dismiss
```

- **Correct it** → opens a tool-calling respond turn pre-seeded with the decision context
- **Dismiss** → marks `status: dismissed`, removed from all future retrieval
- **No action** → decision stands; acknowledgment message expires after 60s (Wire SDK button timeout)

### 5.3 Contradiction Resolution

Replaces the current "One notes that... Shall I mark as superseded?" (unanswered question):

```
Jeeves: I've updated the earlier decision on database choice — the current position
        is PostgreSQL (DEC-43, Tuesday). The earlier MySQL decision (DEC-38) has
        been marked superseded.
        Undo
```

Resolution is declarative and immediate. The user can undo if the merge was wrong.

### 5.4 Human-Readable References in All Responses

Entity IDs (`DEC-42`, `ACT-15`) are retained internally for audit trail and deduplication but **never appear in any user-facing message** — not in confirmations, corrections, lists, or answers. Jeeves refers to "the React decision" or "Sarah's auth PR review" exclusively. Internal IDs are an implementation detail.

### 5.5 Correction Echoes Context

When a correction is made, the response shows before/after:

```
Current: "Decision DEC-38 revoked."
New:     "Done — I've removed the earlier decision to use MySQL.
          The current position is PostgreSQL (DEC-43, from last Tuesday)."
```

---

## 6. Schema Changes

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

## 7. New Dependencies

| Package | Purpose | Notes |
|---|---|---|
| `ai` (Vercel AI SDK) | LLM client, structured output, tool calling | Replaces custom fetch client |
| `zod` | Schema validation for all LLM outputs | Likely already transitive dep |
| `bullmq` | Job queue + scheduling | Replaces InMemoryProcessingQueue + InProcessScheduler |
| `ioredis` | Redis client for BullMQ | New |
| `mem0ai` | Memory management + contradiction resolution | Self-hosted mode |
| `llamaindex` | Retrieval pipeline orchestration | Replaces MultiPathRetrievalEngine |
| `@xenova/transformers` | Local cross-encoder re-ranker | Runs on-prem, no external calls |
| `pgvecto.rs` | Postgres extension (docker image swap) | Drop-in for pgvector |

**Removed dependencies** (or reduced to thin wrappers):
- Custom `LLMClientFactory` — deleted
- Custom `MultiPathRetrievalEngine` — deleted (replaced by LlamaIndex)
- Custom `ContradictionDetector` — deleted (replaced by mem0)
- Custom `InMemoryProcessingQueue` — deleted
- Custom `InProcessScheduler` — deleted

---

## 8. Phased Delivery

### Phase 1 — Reliability Foundation (~2 weeks)

Stop silent failures. Users can trust what the bot captures.

- [ ] Replace `LLMClientFactory` with Vercel AI SDK
- [ ] Replace all `OpenAI*Adapter` JSON parsing with Zod `generateObject()`
- [ ] Replace `InMemoryProcessingQueue` with BullMQ
- [ ] Replace `InProcessScheduler` with BullMQ delayed jobs + cron
- [ ] Add Redis compose service (TTL policy for message content keys)
- [ ] Replace pgvector with pgvecto.rs (docker image swap + migration test)
- [ ] All existing tests pass

**User-visible**: Extraction stops silently dropping messages on local model JSON errors. Reminders survive bot restarts. Overdue action nudges don't skip if bot restarts near cron time.

---

### Phase 2 — Duplication & Deduplication (~2 weeks)

Stop the same fact appearing twice.

- [ ] Add message flagging (Redis set, TTL 5m) on explicit command creation
- [ ] Add write-time similarity check (≥0.85 cosine, 24h window) before decision/action insert
- [ ] Add `contentHash` field + partial unique index to Decision and Action tables
- [ ] Tier 2 extractor respects explicit message flags
- [ ] Add `dismissedAt` and `mergedIntoId` fields + migration
- [ ] Tests: explicit + implicit same message → single record
- [ ] Tests: similar decisions in 24h window → merged, not duplicated

**User-visible**: "Why does Jeeves show the same decision three times?" is resolved.

---

### Phase 3 — Natural Corrections (~3 weeks)

Users fix mistakes in plain English.

- [ ] Replace regex command cascade with intent-first LLM classifier (Stage 1 fast-path + Stage 2 LLM)
- [ ] Assignee ambiguity → clarifying question, not hard error
- [ ] Replace `ContradictionDetector` with mem0 (self-hosted)
- [ ] Tool calling on respond path (Vercel AI SDK `generateText({ tools })`)
- [ ] Implement extraction acknowledgment (button: Correct it | Dismiss)
- [ ] Implement contradiction resolution message (declarative + Undo)
- [ ] Wire button handler for Undo, Correct it, Dismiss
- [ ] Tests: natural language corrections invoke correct tool
- [ ] Tests: contradiction → single merged record + declarative message

**User-visible**: "How do I fix a wrong decision?" → just say so in plain English.

---

### Phase 4 — Retrieval Quality (~2 weeks)

Right answers, not first answers.

- [ ] Replace `MultiPathRetrievalEngine` with LlamaIndex TS `QueryFusionRetriever`
- [ ] Implement `RouterQueryEngine` for intent-driven path selection
- [ ] Add `@xenova/transformers` cross-encoder re-ranker
- [ ] Pass retrieval metadata (paths run, result count, threshold hits) into answer prompt
- [ ] Transparent "I don't have this because..." responses when retrieval returns nothing
- [ ] Tests: relevant result at rank 20 surfaces after re-ranking
- [ ] Tests: empty retrieval → transparent response, not "I'm afraid I have no record"

**User-visible**: Fewer "Jeeves got it wrong" moments; when it doesn't know, it says why.

---

### Phase 5 — Interaction Polish (~1 week)

Feel like a competent assistant, not a command parser.

- [ ] Remove entity IDs from all bot-initiated messages; use human-readable labels
- [ ] Correction responses echo before/after context
- [ ] Remove dead "Any actions from this?" button (replace with tool-backed follow-up)
- [ ] Decision logged → follow-up: "Want me to set a review date or assign follow-up actions?"
- [ ] Action completed → follow-up: "Shall I note this in the next weekly summary?"
- [ ] Reminder fired → follow-up: "Shall I set another for next week?"

**User-visible**: Responses feel conversational. Follow-up prompts are actionable.

---

## 9. What Is Not In Scope for v3.0

| Item | Reason |
|---|---|
| MCP server | Separate capability (external client access); not internal architecture |
| Drizzle ORM migration | High effort, no user-facing gain |
| Horizontal scaling (multiple bot instances) | BullMQ makes this possible but it is a separate milestone |
| Cloud vector DB (Qdrant, Weaviate) | pgvecto.rs is sufficient; migration deferred |
| Streaming responses | Wire SDK does not support streaming message updates |

---

## 10. Open Questions

| # | Question | Owner | Due |
|---|---|---|---|
| 1 | mem0 self-hosted: confirm it supports Ollama-compatible embed endpoints (not just OpenAI) | Engineering | Before Phase 3 start |
| 2 | `@xenova/transformers` cross-encoder model size vs. on-prem memory budget | Engineering | Before Phase 4 start |
| 3 | BullMQ Redis: confirm acceptable for on-prem deployments given extract-and-forget constraints (TTL policy sufficient?) | Security review | Before Phase 1 end |
| 4 | LlamaIndex TS: confirm pgvecto.rs vector store adapter exists or assess build cost | Engineering | Before Phase 4 start |
| 5 | Natural language classifier: latency budget — intent classification must complete in < 500ms on the classify slot model to avoid perceptible delay before Jeeves responds | Engineering | Before Phase 3 start |
| 6 | Token monitoring: instrument per-slot token usage from day one of Phase 1 so deduplication savings vs. classification overhead can be measured empirically in Phase 2 | Engineering | Phase 1 |
