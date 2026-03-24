# Wire Team Bot (Jeeves)

An AI-powered team productivity bot for Wire. Jeeves observes your team conversations, extracts structured knowledge (decisions, actions, entities), and answers questions about your team's history — all while keeping message content inside your infrastructure.

---

## Security and data sovereignty

Wire itself uses end-to-end encryption. Jeeves is an **authorised participant** in the conversations it joins — it sees decrypted content and must be treated with the same sensitivity as a trusted team member.

### Extract-and-forget

Jeeves never stores raw message text. Every message is:
1. Classified in-memory (Tier 1)
2. If high-signal: structured facts are extracted (Tier 2) — only the extracted decisions, actions, and entities are written to the database
3. An embedding vector is computed and stored; the source text is discarded immediately after (Tier 3)

Nothing that could reconstruct a conversation is retained.

### Recommended deployment posture

```
                    ┌──────────────────────────────────────────────┐
                    │  Your infrastructure (Docker host)            │
                    │                                               │
  Wire servers ◄───►│  wire-team-bot  ◄──►  ollama (local models) │
  (E2EE only)       │       │                                      │
                    │       ▼                                      │
                    │    postgres + pgvector                        │
                    └──────────────────────────────────────────────┘
```

- **No inbound ports** — the bot connects outbound to Wire; nothing listens on a public interface.
- **Postgres bound to Docker network** — not reachable from outside the host.
- **Ollama not exposed** — only the bot container can reach it.
- **All inference on-premises** by default. Set `JEEVES_LLM_BASE_URL` to a local Ollama endpoint and no message content ever leaves your network.

---

## Architecture

Jeeves uses a **hexagonal (ports and adapters)** architecture. The domain and application layers have no dependency on Wire, Prisma, or any LLM provider — infrastructure components can be swapped without touching business logic.

```
src/
  app/               # Config, container wiring, entry point
  domain/            # Entities, repository ports, service interfaces
  application/
    usecases/        # Business logic (decisions, actions, reminders, general)
    ports/           # Interfaces: GeneralAnswerPort, RetrievalPort, ClassifierPort, etc.
    services/        # ConversationMessageBuffer
  infrastructure/
    buffer/          # SlidingWindowBuffer (in-memory ring buffer, 30 msgs)
    llm/             # LLMClientFactory + per-slot model adapters
    pipeline/        # ProcessingPipeline (Tier 1→2→3 orchestration)
    queue/           # InMemoryProcessingQueue (async worker pool, max 5 concurrent)
    persistence/     # Prisma/Postgres repositories
    retrieval/       # MultiPathRetrievalEngine + four retrieval paths
    scheduler/       # InProcessScheduler (setTimeout-based, self-rescheduling)
    services/        # Member cache, user resolution
    wire/            # WireEventRouter + WireOutboundAdapter
```

### Processing pipeline (per message)

```
Message received (ACTIVE channel)
        │
        ▼
InMemoryProcessingQueue
        │
        ▼
Tier 1: Classify ── OpenAIClassifierAdapter
  categories[], confidence, entities[], is_high_signal
        │
        ├── is_high_signal=false ──► write ConversationSignal (lightweight)
        │
        └── is_high_signal=true
               │
               ▼
        Tier 2: Extract ── OpenAIExtractionAdapter (sliding window of last 30 msgs)
          ├─ Decision rows      (summary, rationale, decided_by, confidence, source_ref)
          ├─ Action rows        (description, owner, deadline, staleness_at, source_ref)
          ├─ Entity rows        (dedup: pgvector similarity ≥ 0.92 + alias match)
          ├─ EntityRelationship rows
          ├─ ConversationSignal rows
          └─ Contradiction check (similarity search → classify: "does B contradict A?")
               │
               ▼
        Tier 3: Embed ── JeevesEmbeddingAdapter (async, fire-and-forget)
          └─ EmbeddingRepository  (source text discarded after vector computed)
```

### Retrieval engine (per question)

When Jeeves is asked a question, it runs before generating a response:

```
OpenAIQueryAnalysisAdapter  ──►  QueryPlan
  (intent, entities, timeRange, paths, complexity: 0–1)
        │
        ▼
MultiPathRetrievalEngine  (all paths run in parallel via Promise.allSettled)
  ├─ StructuredRetrievalPath   SQL decisions/actions filtered by owner/status/date/tag
  ├─ SemanticRetrievalPath     pgvector HNSW similarity search on embeddings table
  ├─ GraphRetrievalPath        BFS on entity_relationships (depth ≤ 3, max 15 entities)
  └─ SummaryRetrievalPath      cached channel summaries (auto-runs for temporal/institutional)
        │
        ▼
  Weighted RRF merge
    score = Σ(1/(60+rank)) × multi-path-boost(1.5×) × recency × confidence
    token budget: 7,000 tokens
        │
        ▼
OpenAIGeneralAnswerAdapter
  Context prompt: Relevant Decisions / Relevant Actions / Related Context / User's Question
  Model: respond slot; escalates to complexSynthesis when complexity > threshold
```

### Scheduled jobs

| Job | Schedule | What it does |
|---|---|---|
| `staleness_check` | Every 6 hours | Nudges channel for overdue/stale open actions |
| `daily_summary_all` | 08:00 UTC daily | Generates daily rolling summary for all active channels |
| `weekly_summary_all` | Monday 08:00 UTC | Generates weekly summary for all active channels |

All jobs self-reschedule after firing via `InProcessScheduler`.

### Channel state machine

```
ACTIVE  ──► @Jeeves pause / step out ──────►  PAUSED
  ▲          @Jeeves secure mode / ears off ► SECURE (flushes sliding window)
  └────────── @Jeeves resume ◄──────────────────────
```

State is persisted to `channel_config`. SECURE records a `secure_range` timestamp so surrounding context is excluded from future inference.

---

## LLM model slots

Jeeves uses seven purpose-specific model slots, all sharing one OpenAI-compatible endpoint:

| Slot | Purpose | Default model | Env var |
|---|---|---|---|
| `classify` | Tier 1: is this message high-signal? | `qwen3-2507:4b` | `JEEVES_MODEL_CLASSIFY` |
| `extract` | Tier 2: extract decisions/actions/entities | `qwen3-2507:30b-a3b` | `JEEVES_MODEL_EXTRACT` |
| `embed` | Tier 3: compute embedding vectors | `qwen3-embedding:4b` | `JEEVES_MODEL_EMBED` |
| `summarise` | Daily/weekly/on-demand channel summaries | `qwen3-2507:30b-a3b` | `JEEVES_MODEL_SUMMARISE` |
| `queryAnalyse` | Parse question into retrieval plan | `granite4-tiny-h:7b` | `JEEVES_MODEL_QUERY_ANALYSE` |
| `respond` | Generate Jeeves-voice answers | `qwen3-2507:30b-a3b` | `JEEVES_MODEL_RESPOND` |
| `complexSynthesis` | Escalation for complex multi-source queries | `qwen3-next:80b` | `JEEVES_MODEL_COMPLEX` |

Each slot also has a fallback model (`JEEVES_FALLBACK_*`). On timeout or 503, the slot retries once then falls back.

---

## Quick start

### Prerequisites

- Docker and Docker Compose v2
- A Wire account for the bot (`WIRE_SDK_USER_*` credentials)
- An Ollama instance (or any OpenAI-compatible LLM endpoint)

### 1. Clone and configure

```bash
git clone <repo-url>
cd wire-team-bot
cp .env.example .env
# Edit .env — set Wire credentials and JEEVES_LLM_BASE_URL
```

### 2. Start the stack

```bash
docker compose up -d
```

### 3. Add the bot to a Wire conversation

Add the bot user to any group conversation. Jeeves will ask for a brief channel purpose description on first join, then begin listening.

---

## Environment variables

### Wire credentials (all required)

| Variable | Description |
|---|---|
| `WIRE_SDK_USER_EMAIL` | Email of the bot's Wire account |
| `WIRE_SDK_USER_PASSWORD` | Password |
| `WIRE_SDK_USER_ID` | Wire UUID of the bot user |
| `WIRE_SDK_USER_DOMAIN` | Wire federation domain (e.g. `wire.example.com`) |
| `WIRE_SDK_API_HOST` | Wire backend API hostname |
| `WIRE_SDK_CRYPTO_PASSWORD` | Passphrase for the local crypto store |

### Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://wirebot:wirebot@db:5432/wire_team_bot` | PostgreSQL (with pgvector) connection string |

### Jeeves LLM (v2 — seven-slot config)

| Variable | Default | Description |
|---|---|---|
| `JEEVES_LLM_BASE_URL` | *(from `LLM_CAPABLE_BASE_URL`)* | Shared endpoint for all model slots |
| `JEEVES_LLM_API_KEY` | *(from `LLM_CAPABLE_API_KEY`)* | Shared API key |
| `JEEVES_LLM_TIMEOUT_MS` | `60000` | Per-call timeout in milliseconds |
| `JEEVES_MODEL_CLASSIFY` | `qwen3-2507:4b` | Tier 1 classification model |
| `JEEVES_MODEL_EXTRACT` | `qwen3-2507:30b-a3b` | Tier 2 extraction model |
| `JEEVES_MODEL_EMBED` | `qwen3-embedding:4b` | Embedding model |
| `JEEVES_MODEL_SUMMARISE` | `qwen3-2507:30b-a3b` | Summarisation model |
| `JEEVES_MODEL_QUERY_ANALYSE` | `granite4-tiny-h:7b` | Query analysis model |
| `JEEVES_MODEL_RESPOND` | `qwen3-2507:30b-a3b` | Response generation model |
| `JEEVES_MODEL_COMPLEX` | `qwen3-next:80b` | Complex synthesis escalation model |
| `JEEVES_FALLBACK_*` | *(see config.ts)* | Fallback for each slot on 503/timeout |
| `JEEVES_EMBED_DIMS` | `1024` | Embedding vector dimensions — must match your model |
| `JEEVES_COMPLEXITY_THRESHOLD` | `0.7` | Query complexity above which `respond` escalates to `complexSynthesis` |
| `JEEVES_EXTRACT_CONFIDENCE_MIN` | `0.6` | Minimum extraction confidence to persist a result |
| `JEEVES_CONTRADICTION_THRESHOLD` | `0.78` | Cosine similarity to trigger contradiction detection |
| `JEEVES_ENTITY_DEDUP_THRESHOLD` | `0.92` | Cosine similarity for entity deduplication |

### Legacy v1 LLM tiers (still active)

These power the foreground intent router (`create_decision`, `create_action`, etc.) and are not deprecated.

| Variable | Default | Description |
|---|---|---|
| `LLM_PASSIVE_BASE_URL` | `http://ollama:11434/v1` | Endpoint for the v1 ambient classification model |
| `LLM_PASSIVE_MODEL` | `gemma3:4b` | Model for v1 intent classification |
| `LLM_CAPABLE_BASE_URL` | `https://api.openai.com/v1` | Endpoint for v1 capable-tier calls; also seeds `JEEVES_LLM_BASE_URL` default |
| `LLM_CAPABLE_MODEL` | `gpt-4o-mini` | Model for v1 capable-tier calls |
| `LLM_CAPABLE_API_KEY` | *(empty)* | API key for v1 capable tier |

### Application

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `MESSAGE_BUFFER_SIZE` | `50` | Recent messages in memory per conversation (max 500) |
| `STORAGE_DIR` | `storage` | Wire SDK local crypto store directory |
| `SECRET_MODE_INACTIVITY_MS` | `1800000` | Milliseconds of silence before prompting to exit secure mode (default 30 min) |

---

## What Jeeves can do

### Explicit commands (always available, no LLM required)

**Decisions**
- `decision: we're using Postgres` — log a decision
- `decisions about auth` — search decisions
- `list decisions` — list recent decisions
- `revoke DEC-0001 wrong call` — revoke a decision
- `decision: use REST supersedes DEC-0001` — supersede a prior decision

**Actions** (tasks have been consolidated into actions)
- `action: Alice to review the contract` — log an action
- `ACT-0001 done` | `cancelled` | `in_progress` — update status
- `assign ACT-0001 to Mark` | `ACT-0001 reassign to Mark` — reassign
- `ACT-0001 due Friday` — set deadline
- `my actions` | `team actions` | `overdue actions` — list

**Reminders**
- `remind me at 3pm to call John` — set a reminder
- `show reminders` — list yours
- `cancel REM-0001` | `snooze REM-0001 1 hour` — manage

### Intelligent commands (require LLM)

**Questions** — `@Jeeves what did we decide about the API rate limit?`
Jeeves analyses the question, runs the multi-path retrieval engine (structured + semantic + graph + summary), merges results, and answers in Jeeves voice citing channel + date.

**Catch me up** — `@Jeeves catch me up` | `@Jeeves what did I miss`
Posts the most recent daily summary (if fresh), or generates one on-demand for the past 24 hours.

**Status** — `@Jeeves status`
Reports channel state (active/paused/secure), entity counts, last summary date.

**Channel context** — sets metadata that improves retrieval quality:
- `@Jeeves context: This channel coordinates the platform migration project`
- `@Jeeves context type: project` | `team` | `customer` | `general`
- `@Jeeves context tags: backend, migration`
- `@Jeeves context stakeholders: @alice @bob`
- `@Jeeves context related: #ops-channel`

### Passive capture

Jeeves monitors conversations for decisions and facts worth capturing. When it detects one with high confidence, it asks before storing anything. Low-confidence signals are stored as `ConversationSignal` records (searchable, not surfaced directly).

### Channel modes

- `@Jeeves pause` / `step out` → **PAUSED**: Jeeves stops processing until resumed. Responds only to `@Jeeves resume`.
- `@Jeeves secure mode` / `ears off` → **SECURE**: Same as PAUSED, but also flushes the sliding window buffer and records a secure period marker. Context from before/after the secure window is not used for inference.
- `@Jeeves resume` / `come back` → **ACTIVE**: Resume normal processing.

---

## Development

```bash
npm install
cp .env.example .env          # fill in credentials
npx prisma migrate dev        # create the local DB schema
npm run dev                   # start with ts-node watch

npm test                      # run unit + contract tests (Vitest)
npx tsc --noEmit              # type-check
```

Database migrations live in `prisma/migrations/`. The schema is in `prisma/schema.prisma`.

### Test layout

| Directory | What it covers |
|---|---|
| `tests/usecases/` | Unit tests for use cases — fully mocked, no DB/network |
| `tests/pipeline/` | Unit tests for pipeline adapters (classifier, extractor, summariser, query analyser) |
| `tests/retrieval/` | Unit tests for retrieval paths and engine |
| `tests/contract/` | `WireEventRouter` routing contract — mocked use cases, real router |
| `tests/integration/` | Real Postgres + pgvector (requires `INTEGRATION_TESTS=1`) |

### Key files for orientation

| File | Role |
|---|---|
| `src/app/container.ts` | Wires every dependency; where to look when adding new components |
| `src/app/config.ts` | All env var parsing and defaults |
| `src/infrastructure/wire/WireEventRouter.ts` | Message routing: fast-path commands, channel state, pipeline enqueue |
| `src/infrastructure/pipeline/ProcessingPipeline.ts` | Tier 1→2→3 orchestration |
| `src/infrastructure/retrieval/MultiPathRetrievalEngine.ts` | RRF merge of four retrieval paths |
| `prisma/schema.prisma` | Database schema |
