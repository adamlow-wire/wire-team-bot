# Wire Team Bot

Wire Team Bot helps a Wire team capture decisions and actions, recall its history, and follow up on
commitments. The existing app is being prepared for a small real-world pilot.

**[PLAN.md](PLAN.md) defines the app, architecture, feature scope and delivery progress.**
This README is the setup and operations guide. [AGENTS.md](AGENTS.md) contains contributor rules.

Wire Team Bot is an authorised participant and sees decrypted messages. Chat and embedding requests
go to the providers you configure. Use local endpoints for both to keep inference on-premises.
Structured records remain sensitive. Extract-and-forget is the design requirement; the
[plan's current-state review](PLAN.md#3-current-delivery-state) records implementation gaps
that must be closed before sensitive team use. Do not treat the current build as privacy-validated.

## Quick start

### Prerequisites

- Docker and Docker Compose v2
- A linux/x86_64 host. The Wire SDK's CoreCrypto native library needs glibc 2.38 or newer, which the
  `node:22-trixie-slim` image provides. It does not run on Alpine (musl) or on linux/arm64.
- A Wire **application** registered by a team admin, with its app token (`WIRE_SDK_API_TOKEN`). This is not a user login.
- A configured OpenAI-compatible chat endpoint, plus an embedding endpoint if vector features are enabled

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

A team admin adds the Wire Team Bot app to any group conversation. Wire Team Bot will ask for a brief channel purpose description on first join, then begin listening.

---

## Testing against the Wire staging backend

Everything below runs from a dev box with Docker. The image is built locally, so the host's glibc does not matter.

1. **Register Wire Team Bot as a Wire app** (needs a staging team account with admin/owner rights; the backend checks the
   `CreateApp` team permission). The token is the `zuid` cookie the backend hands back; the script checks it against
   `/access` before writing anything.

   ```bash
   node scripts/register-app.mjs versions --host https://staging-nginz-https.zinfra.io          # sanity: API v15+ available
   node scripts/register-app.mjs create   --host https://staging-nginz-https.zinfra.io \
        --email <team-admin@staging> --name "Wire Team Bot (staging)" --out .env.staging
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

4. **Add the app to a conversation** as a team admin in the staging Wire client. Wire Team Bot greets and asks for the
   channel purpose. Then try `decision: ship it`, `@Wire Team Bot what did we decide?`, `remind me in 2 minutes to test`.

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
| `WIRE_SDK_API_TOKEN` | App authentication token minted by a team admin for the Wire Team Bot application |
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

### Wire Team Bot LLM

| Variable | Default | Description |
|---|---|---|
| `JEEVES_LLM_BASE_URL` | `http://localhost:11434/v1` | Shared chat endpoint; embeddings default to it |
| `JEEVES_LLM_API_KEY` | *(empty)* | Shared chat API key; embeddings default to it |
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

### Provider configuration

The client uses OpenAI-style chat completions. Set all chat model slots and their fallbacks to
models available at your chosen endpoint; a matching API shape alone does not validate output
quality. Test the selected configuration with the e2e harness.

Embeddings can use a separate endpoint. `JEEVES_EMBEDDINGS=auto` currently disables them when
the embedding host is `api.anthropic.com`; `off` disables them explicitly. Structured retrieval
and summaries remain available. Vector-dependent semantic retrieval, entity similarity dedup
and contradiction detection require working embeddings.

For a local embedding service in staging:

```bash
npm run staging:up:embeddings
docker exec jeeves-staging-ollama ollama pull qwen3-embedding:4b
```

Set `JEEVES_EMBED_BASE_URL`, model and dimensions accordingly. Current migrations use
`vector(2560)` and exact cosine search. Changing `JEEVES_EMBED_DIMS` alone does not alter the
column. Validate actual output dimensions, including any fallback model; there is currently
no startup dimension check.

Use `JEEVES_*` configuration. The former `LLM_PASSIVE_*` / `LLM_CAPABLE_*` variables are no
longer read by `config.ts`, and those model tiers are not an active foreground router.
See [config.ts](src/app/config.ts) for definitive defaults and [.env.example](.env.example) for
configuration keys; provider-specific examples are not a guarantee of model availability.

### Application

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `MESSAGE_BUFFER_SIZE` | `50` | Recent messages kept per conversation for Q&A context (max 500). Does not affect the Tier 2 extraction window, which is always 30. |
| `SECRET_MODE_INACTIVITY_MS` | `1800000` | Milliseconds of inactivity in SECURE mode before Wire Team Bot prompts the team to resume (minimum 60 000) |

---

## Pilot command reference

These examples describe existing command paths; current acceptance status is in [PLAN.md](PLAN.md).
Replace sample references with the IDs returned by your bot.

| Task | Example |
|---|---|
| Record a decision | `decision: we will use Postgres` |
| Find/list decisions | `decisions about auth`, `list decisions` |
| Correct a decision | `revoke DEC-0001 wrong call`, `decision: use REST supersedes DEC-0001` |
| Record/assign an action | `action: review the contract for Bob` |
| List work | `my actions`, `team actions`, `overdue actions` |
| Update an action | `ACT-0001 done`, `ACT-0001 reassign to Bob`, `ACT-0001 due Friday` |
| Set a reminder | `remind me in 2 minutes to check the deployment` |
| Manage reminders | `show reminders`, `cancel REM-0001`, `snooze REM-0001 1 hour` |
| Ask/catch up | `@Wire Team Bot what did we decide?`, `@Wire Team Bot catch me up` |
| Inspect channel | `@Wire Team Bot status` |
| Set purpose | `@Wire Team Bot context: This channel coordinates the platform migration` |
| Control listening | `@Wire Team Bot pause`, `@Wire Team Bot secure mode`, `@Wire Team Bot resume` |

Use an actual Wire mention for addressed commands, especially when resuming from PAUSED or
SECURE. Q&A and summaries require a model endpoint. Passive extraction runs in ACTIVE channels.
Use text commands for corrections during the pilot; existing button offers are not a complete
workflow. Privacy/state-isolation fixes remain a pilot gate in the plan.

## Development

```bash
npm ci                        # see "Dependency notes" below before using plain `npm install`
cp .env.example .env          # fill in the Wire app token, app ID and crypto key
npx prisma migrate dev        # create the local DB schema
npm run dev                   # start with ts-node

npm test                      # run unit + contract tests (Vitest)
npx tsc --noEmit              # type-check

npm run build && npm run test:e2e            # end-to-end LLM-as-judge test suite
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

## Official SDK cutover

This runbook is for deployments still using the old fork/user-account bot. See
[PLAN.md](PLAN.md) for recorded staging results and cutover status. Do not recreate storage
on ordinary restarts.

1. Record the old image tag and configuration, and list existing channels:
   `SELECT channel_id, channel_name FROM channel_config;`.
2. Stop the old stack. Back up Postgres, the old crypto volume and configuration. Preserve
   them for rollback; the old fork's SQLite/MLS state is incompatible with the new app identity.
3. Register the new application with a team admin using the steps above. Deploy a pinned image
   with the new app configuration and a **fresh, separate** crypto volume. Keep the existing
   Postgres data; review any image migrations before startup.
4. Start and check migrations, CoreCrypto initialisation and connection. An empty member cache
   is expected for an app that has not joined any conversations yet.
5. Have the team admin add the new app to the intended channels. Verify decisions, Q&A and a
   short reminder. Check member names and channel state.
6. Restart, send another message and confirm it decrypts. Test a reminder due across restart.
   Check 1:1 behaviour separately; do not assume org-wide personal retrieval is supported.
7. Record results against the pilot gates in PLAN.md. Roll back if necessary using the old
   image, configuration and backed-up crypto volume; restore Postgres if migrations require it.

Keep the token, crypto key and volume together as the application's identity state. A token
refresh changes the token only. Removing a volume or regenerating the key is not a refresh.
