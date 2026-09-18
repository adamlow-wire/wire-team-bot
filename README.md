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

A team admin adds the Wire Team Bot app to the designated test conversation first. The greeting explains how to save a purpose using an explicit `context:` command.

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
column. Validate actual output dimensions, including any fallback model; enabled configuration must use 2560, and model responses (including fallback) are checked for finite values and matching dimensions. There is no live startup embedding probe.

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
Replace sample references with the IDs returned by your bot. Send one command per message;
multiple requests in one message are not currently supported.

| Task | Example |
|---|---|
| Record a decision | `decision: we will use Postgres` |
| Find/list decisions | `decisions about auth`, `list decisions` |
| Correct a decision | `revoke DEC-0001 wrong call`, `decision: use REST supersedes DEC-0001` |
| Record/assign an action | `action: review the contract for Bob` |
| Assign a named task | `@Wire Team Bot @Bob needs to review the checklist by Friday` |
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
Direct command confirmations and answers use Wire’s native reply to identify the source message.
Scheduled notifications remain standalone; self-deleting sources cannot be quoted by Wire.
Passive action capture is quiet but visible: **📝** means at least one action was saved from
that message; **✅** means at least one completion was saved. Both may appear when a message
does both. Reactions follow the record and audit writes; duplicates, rejected captures and
PAUSED/SECURE messages get no success reaction. Use `my actions` or `team actions` to inspect
owners and deadlines. A failed reaction send leaves the saved record intact; reactions are not
retried durably or backfilled onto older messages. Passive decisions do not receive these action
reactions. Explicit commands retain their text confirmations.

Use text commands for corrections. Supported text commands also accept a leading single-line inline-code span
around the command prefix or whole command when pasted from an example. This includes
reminders, decisions, actions and addressed privacy controls; code blocks and prose examples
are not treated as direct commands. Actual person mentions carry their qualified user identity through action creation and
reassignment, with membership checked in this conversation. Plain-text assignees require an
unambiguous full name or handle. The addressed named-task variant also accepts `@Bob really needs to …`.
Decision button offers have been removed; clicks on old buttons give text guidance. Mention the bot with `resume` while paused or secure. The `JEEVES_*` configuration keys and old bot-name text prefix remain compatible; the product name is Wire Team Bot.

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
npm run test:acceptance                     # fixed 20-event stored-record sample + 10 known questions
npm run build && npm run simulate           # multi-day replay — stored-record inventory
npm run simulate:review                     # human source/fact review, including missed captures
```

Database migrations live in `prisma/migrations/`. The schema is in `prisma/schema.prisma`.

### Dependency notes

- **Runtime requirement.** `@wireapp/wire-apps-js-sdk` pulls in `@wireapp/core-crypto`, whose native library needs
  glibc 2.38+ on linux/x86_64 (or macOS). Importing the SDK on an older glibc (for example Ubuntu 22.04 / WSL) fails at
  load time, which also breaks `npm test` and the CLI/e2e harness locally. Run them in a container instead:

  ```bash
  docker run --rm --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm-cache -v "$PWD":/app -w /app node:22-trixie-slim npx vitest run
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

## Release-candidate acceptance

The current local image is `wire-team-bot:v3-rc-7384b39`. See [PLAN.md](PLAN.md#candidate-disposition--2026-09-18)
for passing checks, the retained e2e failures and human/Wire acceptance still required.

Use synthetic data in a separate database. The development run used Postgres 16 + pgvector,
`node:22-trixie-slim`, and the existing staging provider settings. Embeddings were explicitly
off for model journeys. The database/vector adapter was checked separately with 2560-dimensional
synthetic vectors. No running staging or production service needs to be stopped for these tests.

```bash
# Create once; this is a new, disposable acceptance database, not the team database.
docker run -d --name wire-team-bot-v3-test-db \
  -e POSTGRES_USER=wirebot -e POSTGRES_PASSWORD=synthetic-only \
  -e POSTGRES_DB=wire_team_bot_test -p 127.0.0.1:55439:5432 pgvector/pgvector:pg16

# Run from the checkout, with approved model settings already in .env.staging.
# This shell is only the test container; CLI/evaluation never connects to Wire.
docker run --rm -it --network host --user "$(id -u):$(id -g)" \
  --env-file .env.staging -e npm_config_cache=/tmp/npm-cache \
  -e DATABASE_URL=postgresql://wirebot:synthetic-only@127.0.0.1:55439/wire_team_bot_test \
  -e JEEVES_EMBEDDINGS=off -v "$PWD":/app -w /app node:22-trixie-slim bash

# Inside that container:
npx prisma migrate deploy
npm run build
npx tsc --noEmit
npm run lint
npm test
INTEGRATION_TESTS=1 npm test
npm run test:e2e -- --json
EVALUATION_COMMIT=<tested-commit> npm run test:acceptance
EVALUATION_COMMIT=<tested-commit> npm run simulate
npm run simulate:review
```

`--network host` is for this Linux test environment. Do not point these commands at a shared
team database. The test harness uses isolated conversation IDs and only removes rows owned by
its integration fixtures. No reset command is required. The e2e and simulation scripts use the
already installed `ts-node`; they do not download an unpinned runner.

To repeat the reaction lifecycle check in that isolated test container:

```bash
EVALUATION_COMMIT=7384b39 \
EVALUATION_FIXTURE=tests/acceptance/reaction-fixture.json \
EVALUATION_REPORT=tests/acceptance/reaction-report.json npm run test:acceptance
```

Check the report's separate `reactions` arrays against source events: 📝 for `reaction-create`,
✅ for `reaction-complete`, and none for explicit creation or ordinary chat. Inspect stored
records after drain: the checklist belongs to Bob and is done; the explicit report belongs to
Carol and stays open. Verify the corresponding action audits as well. Reactions are not capture
scores; the evaluator still matches every stored record against expected facts/source events.
Actual Wire client display requires a new unmentioned commitment and completion in the test
conversation; existing records do not receive retroactive reactions.

The original `e35428b` baseline was built in a separate archived checkout with only
[baseline-cli.patch](tests/acceptance/baseline-cli.patch) applied. That patch adds stable input IDs,
framed replies and per-event drain to its CLI; it does not change routing, model prompts or writes.
To reproduce, archive `e35428b` into a temporary directory, apply the patch with `patch -p1`, use the
same locked dependencies and build it. Run the current evaluator with `EVALUATION_ROOT` pointing
to that checkout, `EVALUATION_COMMIT=e35428b` and a separate `EVALUATION_REPORT` output path.
Use the same isolated DB and model slots listed in the baseline report.

The fixed sample is [capture-fixture.json](tests/acceptance/capture-fixture.json). Compare
[baseline-report.json](tests/acceptance/baseline-report.json) and
[candidate-report.json](tests/acceptance/candidate-report.json), including every record and
question answer. Records match by expected fact, source event and owner; generated record IDs
are not scoring keys. Precision counts duplicate/wrong captures in its denominator, and recall
counts all expected events. The report includes marker occurrences in stored records and
stderr, elapsed event times, failures and unsolicited-message counts. Times include processing
and queue drain; they are not a first-token benchmark. Legacy prefixes in fixtures deliberately
exercise command compatibility.

Simulation inventory is written to `tests/simulation/simulation-report.json`; it is synthetic,
local and gitignored. Its `expected: 0` means **unreviewed**, not perfect recall. Review the actual
source events and stored content with `simulate:review`, record misses as well as false positives,
and put the reviewer/date and decision in PLAN.md. `golden.json` must not be presented as approved
while it only contains instructions. Human review of the fixed sample and ten known answers is
also required before the pilot.

Build a pinned candidate from the tested checkout, then exercise its CLI against the isolated
DB using `--entrypoint node <image> dist/app/cli.js`. The normal entrypoint starts the Wire bot;
only use it when the operator is ready for the designated Wire test.

```bash
docker build --label org.opencontainers.image.revision=<tested-commit> \
  -t wire-team-bot:v3-rc-<tested-commit> .
```

To run the unchanged e2e suite against that image's compiled runtime, mount only the test harness
and its development tooling. Keep `/app/dist` and `/app/node_modules` from the image:

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" \
  --env-file .env.staging \
  -e DATABASE_URL=postgresql://wirebot:synthetic-only@127.0.0.1:55439/wire_team_bot_test \
  -e JEEVES_EMBEDDINGS=off -e NODE_PATH=/validation/node_modules \
  -v "$PWD/tests":/app/tests:ro \
  -v "$PWD/node_modules":/validation/node_modules:ro \
  -v "$PWD/tsconfig.json":/validation/tsconfig.json:ro \
  --entrypoint node wire-team-bot:v3-rc-7384b39 \
  /validation/node_modules/ts-node/dist/bin.js --transpile-only \
  --project /validation/tsconfig.json /app/tests/e2e/runner.ts --json
```

The `.dockerignore` excludes secrets, crypto storage, tests, local dependencies and Git metadata
from the image context. Preserve the existing crypto key/store when testing restart. Delivery is
at least once: a crash after a successful reminder send but before the database update can cause
a repeat. The in-memory capture queue is intentionally transient and loses unfinished work on
restart. Arbitrary edited messages do not update records; use the documented correction commands.

## Designated Wire smoke test

Record the qualified test conversation (`ID@domain`), operator, second named member, approved
provider settings and human reviewer in PLAN.md. A conversation name is sufficient to begin:
the operator can supply its name, and the bot’s local SDK store can resolve its ID if it has joined. Do not use a real team channel
until the synthetic privacy/access checks have passed. Use actual Wire mentions below; plain text
that looks like a mention is not sufficient for resume from PAUSED/SECURE.

1. Start the pinned candidate with the designated staging identity and persistent crypto store.
   Record image digest, commit, provider model names, embedding mode and the test conversation in
   PLAN.md; never copy tokens or keys. Verify the registered app display name is **Wire Team Bot**.
2. In the designated channel, send `decision: use Postgres for the pilot ledger because transactions
   are required`. Save its `DEC-` reference. Mention the bot and ask what was decided and why.
   Record a replacement with `decision: use Postgres 16 supersedes DEC-…` using that active
   decision as the target. Revoke the replacement using its new ID, and check both records and
   audit entries.
3. Send `action: <member> to review the pilot checklist by Friday`. Verify the stored owner ID,
   display name and deadline, list it, reassign it, change its deadline and mark it done. Repeat
   an unknown and an ambiguous name: no guessed owner should be written. Restart and verify names
   still resolve on the first subsequent message.
4. Create a short reminder, cancel another, and snooze a third. Restart before one is due; stop the
   candidate until another is overdue and start it again. Confirm delivery and durable status.
   Failed-send recovery is covered by injected-failure DB tests; if an operator reproduces a real
   transport interruption, verify pending state and a later retry, allowing duplicate delivery.
5. Send an ambient commitment and verify the silent stored action once processing finishes. Send
   its completion as the owner and verify status becomes done. Check that explicit commands were
   not also captured by the passive pipeline. Inspect catch-up output and open/overdue lists.
6. Start a slow synthetic extraction, then mention `pause` or `secure mode`. Wait for confirmation;
   send a unique excluded marker, restart, send a second excluded marker, then mention `resume`.
   Ask a new question and inspect both model diagnostics and channel records: neither excluded
   marker may appear. Repeat for both states. A failed state-persistence warning is a failed check,
   not permission to restart under an assumed durable pause.
7. In a second designated test channel, try the first channel’s record IDs for recall and changes;
   they must not expose or alter those records. Domain-collision denial is covered by automated
   negative tests; exercise federation manually if that is part of this pilot deployment.
8. Confirm reconnect/decryption after restart, text corrections, no required inert buttons, and
   no fabricated successful write from a Q&A follow-up. Record actual outputs and pass/fail in
   PLAN.md. Then obtain human approval of at least 20 capture events and 8/10 useful answers.

Begin the five-working-day P3 pilot only after the unresolved acceptance items in PLAN.md are
closed. Use a short feedback log for saved effort, errors, latency and noise, then choose keep,
fix or stop. Production deployment remains a separate operator action.
