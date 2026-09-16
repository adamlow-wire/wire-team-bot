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
- **Designed for on-premises deployment** — point both `JEEVES_LLM_BASE_URL` and `LLM_CAPABLE_BASE_URL` at a local Ollama instance and no message content ever leaves your network.

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
    services/        # ConversationMessageBuffer (Q&A context, 50 msgs default)
  infrastructure/
    buffer/          # SlidingWindowBuffer (extraction context, 30 msgs hard limit)
    llm/             # LLMClientFactory + per-slot model adapters
    pipeline/        # ProcessingPipeline (Tier 1→2→3 orchestration)
    queue/           # InMemoryProcessingQueue (async worker pool, max 5 concurrent)
    persistence/     # Prisma/Postgres repositories
    retrieval/       # MultiPathRetrievalEngine + four retrieval paths
    scheduler/       # InProcessScheduler (setTimeout-based, self-rescheduling)
    services/        # InMemoryMemberCache — display name resolution
    wire/            # WireEventRouter + WireOutboundAdapter
```

There are two distinct in-memory buffers:
- **`SlidingWindowBuffer`** (30 messages, hard limit) — per-channel ring buffer fed to the Tier 2 extractor as conversation context for each LLM call.
- **`ConversationMessageBuffer`** (50 messages default, max 500, configurable via `MESSAGE_BUFFER_SIZE`) — per-conversation buffer that provides recent message history to the Q&A answer generator.

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
                 │  if contradicted → notify channel
               ▼
        Tier 3: Embed ── JeevesEmbeddingAdapter (async, fire-and-forget)
          └─ EmbeddingRepository  (source text discarded after vector computed)
```

All extracted items are stored immediately if confidence ≥ `JEEVES_EXTRACT_CONFIDENCE_MIN`. If a new decision appears to contradict an existing one, Jeeves posts a notice to the channel after storing both.

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

All jobs self-reschedule after firing via `InProcessScheduler`. Schedules are UTC and not currently configurable via env var.

### Channel state machine

```
ACTIVE  ──► @Jeeves pause / step out ────────────────►  PAUSED
  ▲          @Jeeves secure mode / safe mode / ears off ► SECURE (flushes sliding window)
  └────────── @Jeeves resume / come back ◄──────────────────────
```

State is persisted to `channel_config`. SECURE records a `secure_range` timestamp so surrounding context is excluded from future inference. If the channel goes quiet while in SECURE mode, Jeeves will send a reminder after `SECRET_MODE_INACTIVITY_MS` (default 30 min) prompting the team to resume.

---

## LLM model slots

Jeeves uses seven purpose-specific model slots, all sharing one OpenAI-compatible endpoint:

| Slot | Purpose | Default model | Env var |
|---|---|---|---|
| `classify` | Tier 1: is this message high-signal? | `qwen3-next:80b` | `JEEVES_MODEL_CLASSIFY` |
| `extract` | Tier 2: extract decisions/actions/entities | `qwen3-next:80b` | `JEEVES_MODEL_EXTRACT` |
| `embed` | Tier 3: compute embedding vectors | `qwen3-embedding:4b` | `JEEVES_MODEL_EMBED` |
| `summarise` | Daily/weekly/on-demand channel summaries | `qwen3-next:80b` | `JEEVES_MODEL_SUMMARISE` |
| `queryAnalyse` | Parse question into retrieval plan | `qwen3-next:80b` | `JEEVES_MODEL_QUERY_ANALYSE` |
| `respond` | Generate Jeeves-voice answers | `qwen3-next:80b` | `JEEVES_MODEL_RESPOND` |
| `complexSynthesis` | Escalation for complex multi-source queries | `gpt-oss:120b` | `JEEVES_MODEL_COMPLEX` |

Each slot also has a fallback model (`JEEVES_FALLBACK_*`). On timeout or 503, the slot retries once then falls back.

---

## Quick start

### Prerequisites

- Docker and Docker Compose v2
- A linux/x86_64 host. The Wire SDK's CoreCrypto native library needs glibc 2.38 or newer, which the
  `node:22-trixie-slim` image provides. It does not run on Alpine (musl) or on linux/arm64.
- A Wire **application** registered by a team admin, with its app token (`WIRE_SDK_API_TOKEN`). This is not a user login.
- An Ollama instance (or any OpenAI-compatible LLM endpoint)

### 1. Clone and configure

```bash
git clone <repo-url>
cd wire-team-bot
cp .env.example .env
# Edit .env — set the Wire app token / app ID, generate WIRE_SDK_CRYPTO_KEY, set JEEVES_LLM_BASE_URL
openssl rand -hex 32   # paste as WIRE_SDK_CRYPTO_KEY
```

### 2. Start the stack

```bash
docker compose up -d
```

### 3. Add the app to a Wire conversation

A team admin adds the Jeeves app to any group conversation. Jeeves will ask for a brief channel purpose description on first join, then begin listening.

---

## Testing against the Wire staging backend

Everything below runs from a dev box with Docker. The image is built locally, so the host's glibc does not matter.

1. **Register Jeeves as a Wire app** (needs a staging team account with admin/owner rights; the backend checks the
   `CreateApp` team permission). The token is the `zuid` cookie the backend hands back; the script checks it against
   `/access` before writing anything.

   ```bash
   node scripts/register-app.mjs versions --host https://staging-nginz-https.zinfra.io          # sanity: API v15+ available
   node scripts/register-app.mjs create   --host https://staging-nginz-https.zinfra.io \
        --email <team-admin@staging> --name "Jeeves (staging)" --out .env.staging
   ```

   You are prompted for the admin password (never echoed). If the account has a second factor enabled, run
   `send-code` first and pass `--code`. `.env.staging` is written with mode 0600 and is gitignored. It contains
   `WIRE_SDK_API_HOST`, `WIRE_SDK_APP_ID`, `WIRE_SDK_APP_DOMAIN`, `WIRE_SDK_API_TOKEN`, and a freshly generated
   `WIRE_SDK_CRYPTO_KEY`.

2. **Add your LLM settings** (`JEEVES_LLM_BASE_URL`, `JEEVES_LLM_API_KEY`, model overrides) to `.env.staging`.

3. **Start the staging stack** (own container names, volumes, and Postgres port 5433, so it coexists with a production stack):

   ```bash
   npm run staging:up
   npm run staging:logs        # expect: migrations, "CoreCrypto initialized", websocket connected
   ```

4. **Add the app to a conversation** as a team admin in the staging Wire client. Jeeves greets and asks for the
   channel purpose. Then try `decision: ship it`, `@Jeeves what did we decide?`, `remind me in 2 minutes to test`.

5. **Restart test**: `docker restart jeeves-staging`, then send another message. It must still decrypt; the SDK's
   persistent keystore is the point of this migration.

6. **Token expired or revoked?** Mint a new one without creating a new identity, then restart:

   ```bash
   node scripts/register-app.mjs refresh --host https://staging-nginz-https.zinfra.io \
        --email <team-admin@staging> --app-id <WIRE_SDK_APP_ID> --print-token
   ```

   Keep the existing `WIRE_SDK_CRYPTO_KEY` and volume; only `WIRE_SDK_API_TOKEN` changes.

`npm run staging:down` stops the stack. Add `-v` manually (`docker compose -f docker-compose.staging.yml down -v`) only
when you want to throw away the staging identity's crypto store and start over with a new `create`.

## Environment variables

### Wire application (all required)

| Variable | Description |
|---|---|
| `WIRE_SDK_API_TOKEN` | App authentication token minted by a team admin for the Jeeves application |
| `WIRE_SDK_API_HOST` | Wire backend API base URL (e.g. `https://prod-nginz-https.wire.com`) |
| `WIRE_SDK_APP_ID` | Wire UUID of the application; verified against the backend at startup |
| `WIRE_SDK_APP_DOMAIN` | Wire federation domain of the application (e.g. `wire.example.com`) |
| `WIRE_SDK_CRYPTO_KEY` | 32 random bytes, hex-encoded (64 chars), protecting the local CoreCrypto keystore. Generate with `openssl rand -hex 32`. Losing it means losing all E2EE state. |

The SDK stores its SQLite database and keystore under `./storage` relative to the process working directory
(`/app/storage` in the container, mounted as the `jeeves-crypto` volume).

### Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://wirebot:wirebot@localhost:5432/wire_team_bot` | PostgreSQL (with pgvector) connection string. The docker-compose stack overrides this to `postgres:5432` automatically. |

### Jeeves LLM (v2 — seven-slot config)

| Variable | Default | Description |
|---|---|---|
| `JEEVES_LLM_BASE_URL` | *(from `LLM_CAPABLE_BASE_URL`)* | Shared endpoint for all model slots |
| `JEEVES_LLM_API_KEY` | *(from `LLM_CAPABLE_API_KEY`)* | Shared API key |
| `JEEVES_LLM_TIMEOUT_MS` | `60000` | Per-call timeout in milliseconds |
| `JEEVES_EMBED_BASE_URL` | *(= `JEEVES_LLM_BASE_URL`)* | Separate OpenAI-compatible `/embeddings` provider, for chat providers without one (Anthropic) |
| `JEEVES_EMBED_API_KEY` | *(= `JEEVES_LLM_API_KEY`)* | API key for the embedding provider |
| `JEEVES_EMBEDDINGS` | `auto` | `auto` disables embeddings when the embedding host is `api.anthropic.com`; `on` / `off` force it |
| `JEEVES_MODEL_CLASSIFY` | `qwen3-next:80b` | Tier 1 classification model |
| `JEEVES_MODEL_EXTRACT` | `qwen3-next:80b` | Tier 2 extraction model |
| `JEEVES_MODEL_EMBED` | `qwen3-embedding:4b` | Embedding model |
| `JEEVES_MODEL_SUMMARISE` | `qwen3-next:80b` | Summarisation model |
| `JEEVES_MODEL_QUERY_ANALYSE` | `qwen3-next:80b` | Query analysis model |
| `JEEVES_MODEL_RESPOND` | `qwen3-next:80b` | Response generation model |
| `JEEVES_MODEL_COMPLEX` | `gpt-oss:120b` | Complex synthesis escalation model |
| `JEEVES_FALLBACK_*` | *(see config.ts)* | Fallback for each slot on 503/timeout |
| `JEEVES_EMBED_DIMS` | `2560` | Embedding vector dimensions — must match your model |
| `JEEVES_COMPLEXITY_THRESHOLD` | `0.7` | Query complexity above which `respond` escalates to `complexSynthesis` |
| `JEEVES_EXTRACT_CONFIDENCE_MIN` | `0.6` | Minimum extraction confidence to persist a result |
| `JEEVES_CONTRADICTION_THRESHOLD` | `0.78` | Cosine similarity to trigger contradiction detection |
| `JEEVES_ENTITY_DEDUP_THRESHOLD` | `0.92` | Cosine similarity for entity deduplication |

#### Using Claude

Anthropic's API serves OpenAI-style chat completions at `https://api.anthropic.com/v1`, so the six chat slots work with a
Claude API key and Claude model IDs (`claude-opus-5`, `claude-haiku-4-5` for the high-volume `classify` slot). Two
caveats, both handled:

- **No embeddings.** Anthropic has no `/embeddings` endpoint. With `JEEVES_EMBEDDINGS=auto` (the default) and no
  `JEEVES_EMBED_BASE_URL`, embeddings switch off at startup with one warning, and Jeeves runs without semantic
  retrieval, entity dedup and contradiction detection. Structured retrieval, summaries, commands and Q&A still work.
  To keep the vector features, point `JEEVES_EMBED_BASE_URL` at Ollama or another OpenAI-compatible provider and set
  `JEEVES_MODEL_EMBED` / `JEEVES_EMBED_DIMS` to match. The staging compose file ships an optional Ollama for this:
  `docker compose -f docker-compose.staging.yml --profile embeddings up -d`, then
  `docker exec jeeves-staging-ollama ollama pull qwen3-embedding:4b`.
- **JSON mode is ignored** by Anthropic's compatibility layer. The structured slots ask for JSON in their prompts and
  strip code fences, so this works in practice; occasional fallback-path warnings are expected. Anthropic documents the
  layer as intended for evaluation rather than production; the native Anthropic SDK is the long-term path.

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
| `BOT_NAME` | `Jeeves` | Persona name used in prompts, greetings and prefix addressing (`<name> pause`). The display name shown in Wire is set on the app in Wire, not here. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `MESSAGE_BUFFER_SIZE` | `50` | Recent messages kept per conversation for Q&A context (max 500). Does not affect the Tier 2 extraction window, which is always 30. |
| `SECRET_MODE_INACTIVITY_MS` | `1800000` | Milliseconds of inactivity in SECURE mode before Jeeves prompts the team to resume (minimum 60 000) |

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

Jeeves silently monitors conversations for decisions and facts worth capturing. When it detects a high-signal message (confidence ≥ `JEEVES_EXTRACT_CONFIDENCE_MIN`), the extracted decisions, actions, and entities are stored immediately — no confirmation is requested. Low-confidence signals are stored as `ConversationSignal` records (searchable, not surfaced directly).

If a newly extracted decision appears to contradict an existing one, Jeeves posts a notice to the channel and asks whether to mark the earlier decision as superseded.

### Channel modes

- `@Jeeves pause` / `step out` → **PAUSED**: Jeeves stops processing until resumed. Responds only to `@Jeeves resume`.
- `@Jeeves secure mode` / `safe mode` / `ears off` → **SECURE**: Same as PAUSED, but also flushes the sliding window buffer and records a secure period marker. Context from before/after the secure window is not used for inference. If the channel stays quiet, Jeeves will prompt to resume after `SECRET_MODE_INACTIVITY_MS` (default 30 min).
- `@Jeeves resume` / `come back` → **ACTIVE**: Resume normal processing.

All channel mode commands accept an optional trailing _"please"_.

---

## Development

```bash
npm ci                        # see "Dependency notes" below before using plain `npm install`
cp .env.example .env          # fill in the Wire app token, app ID and crypto key
npx prisma migrate dev        # create the local DB schema
npm run dev                   # start with ts-node watch

npm test                      # run unit + contract tests (Vitest)
npx tsc --noEmit              # type-check

npm run build && npm run test:e2e            # end-to-end LLM-as-judge test suite (~55 scenarios)
npm run test:e2e -- --filter TC-DEC         # run a subset of scenarios
npm run build && npm run simulate           # multi-day channel replay — extraction quality report
npm run simulate:review                     # annotate report as golden baseline (precision/recall)
```

Database migrations live in `prisma/migrations/`. The schema is in `prisma/schema.prisma`.

### Dependency notes

- **Runtime requirement.** `@wireapp/wire-apps-js-sdk` pulls in `@wireapp/core-crypto`, whose native library needs
  glibc 2.38+ on linux/x86_64 (or macOS). Importing the SDK on an older glibc (for example Ubuntu 22.04 / WSL) fails at
  load time, which also breaks `npm test` and the CLI/e2e harness locally. Run them in a container instead:

  ```bash
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app node:22-trixie-slim npx vitest run
  ```

- **`npm install` on npm 10.9.x** fails with `Cannot read properties of null (reading 'edgesOut')` while resolving
  this tree. Use `npm ci` with the committed lockfile, or npm 11+ (`npx npm@12 install`) when you need to change
  dependencies.
- **`npm ci` compiles better-sqlite3 unnecessarily** on npm 10 (it ignores the package's `gypfile: false` when
  reading from the lockfile). The Dockerfile and CI therefore run
  `npm ci --ignore-scripts && npm rebuild prisma @prisma/client @prisma/engines`; Prisma is the only dependency whose
  install hooks are needed. On a machine with a C++ toolchain, plain `npm ci` also works, just slower.

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
