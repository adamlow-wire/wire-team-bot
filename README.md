# Wire Team Bot

An AI-powered team productivity bot for Wire that records decisions, tasks, actions, reminders, and institutional knowledge directly from your conversations.

---

## Security and data sovereignty

Wire itself uses end-to-end encryption. This bot operates inside that trust boundary — it is an **authorised participant** in the conversations it joins, not a passive network tap. That means a few things matter a great deal:

- **The bot sees decrypted message content.** It must be treated with the same sensitivity as a human team member who has been added to those conversations.
- **Where inference happens matters.** If intent classification is performed by a cloud API (OpenAI, Anthropic, etc.) then message fragments are transmitted to that provider's servers. For most organisations this is unacceptable for internal conversations.
- **The recommended deployment keeps all data inside your network.** The passive LLM (see below) runs locally via Ollama with no outbound connections beyond what Wire itself requires. No message content leaves your infrastructure.

### Recommended deployment posture

```
                    ┌──────────────────────────────────────┐
                    │  Your infrastructure (Docker host)    │
                    │                                        │
  Wire servers ◄───►│  wire-team-bot  ◄──► ollama (local)  │
  (E2EE only)       │       │                               │
                    │       ▼                               │
                    │    postgres                           │
                    └──────────────────────────────────────┘
```

- **No inbound ports** — the bot connects outbound to Wire only; nothing listens on a public interface.
- **Postgres bound to localhost** — not reachable from outside the Docker host.
- **Ollama not exposed** — only reachable by the bot container on the internal Docker network.
- **Capable (cloud) LLM is optional.** If you only set `LLM_PASSIVE_*` and leave `LLM_CAPABLE_*` unset, every LLM call uses the local model and nothing leaves the host.

---

## Split model architecture

The bot distinguishes two tiers of LLM usage:

| Tier | Purpose | Recommended model |
|---|---|---|
| **Passive** | Runs on every message: intent classification, `shouldRespond` decision, passive knowledge capture detection. Must be fast and low-cost. | Local — Qwen3 8B or Gemma 3 4B via Ollama |
| **Capable** | Reserved for tasks that benefit from stronger reasoning: complex summarisation, semantic ranking, future multi-step planning. | Cloud — GPT-4o, Claude 3.5 Sonnet, or a larger local model |

Both tiers speak the OpenAI-compatible `/v1/chat/completions` API, so Ollama, vLLM, LM Studio, and any OpenAI-compatible endpoint work out of the box.

If `LLM_PASSIVE_*` variables are not set, the passive tier falls back to the capable tier config. If neither is configured, LLM features are disabled and the bot operates in command-only mode (fast-path regex routing still works for all explicit `TASK-`, `ACT-`, `REM-`, `KB-` commands).

---

## Quick start

### Prerequisites

- Docker and Docker Compose v2
- A Wire account for the bot (`WIRE_SDK_USER_*` credentials)
- *(Optional for cloud LLM)* An OpenAI-compatible API key

### 1. Clone and configure

```bash
git clone <repo-url>
cd wire-team-bot
cp .env.example .env
# Edit .env — see Environment variables below
```

### 2. Start the stack

```bash
docker compose up -d
```

On first start, Ollama will pull the passive model (`qwen3:8b` by default — ~5 GB). This happens once; the model is persisted in the `ollama-data` volume.

To use a different model:

```bash
LLM_PASSIVE_MODEL=gemma3:4b docker compose up -d
```

### 3. Add the bot to a Wire conversation

Log in to Wire as the bot user and add it to any group conversation. It will begin listening immediately.

---

## Environment variables

Copy `.env.example` to `.env` and fill in the required values. All variables are optional unless marked **required**.

### Wire credentials (all required)

| Variable | Description |
|---|---|
| `WIRE_SDK_USER_EMAIL` | Email address of the bot's Wire account |
| `WIRE_SDK_USER_PASSWORD` | Password of the bot's Wire account |
| `WIRE_SDK_USER_ID` | Wire UUID of the bot user (found in Wire admin or account settings) |
| `WIRE_SDK_USER_DOMAIN` | Wire federation domain (e.g. `wire.example.com`) |
| `WIRE_SDK_API_HOST` | Wire backend API hostname (e.g. `https://api.wire.example.com`) |
| `WIRE_SDK_CRYPTO_PASSWORD` | Passphrase used to encrypt the local crypto store |

### Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://wirebot:wirebot@db:5432/wire_team_bot` | PostgreSQL connection string. In Docker Compose the default points at the bundled `db` service. |

### Passive LLM (ambient listening)

The passive model runs on every received message. Use a local model to keep data on-premises.

| Variable | Default | Description |
|---|---|---|
| `LLM_PASSIVE_PROVIDER` | `ollama` | Provider name (informational). |
| `LLM_PASSIVE_BASE_URL` | `http://ollama:11434/v1` | Base URL of the OpenAI-compatible API endpoint. |
| `LLM_PASSIVE_MODEL` | `qwen3:8b` | Model identifier as understood by the provider (e.g. `gemma3:4b`, `qwen3:8b`). |
| `LLM_PASSIVE_API_KEY` | *(empty)* | API key. Not required for local Ollama. |
| `LLM_PASSIVE_ENABLED` | `true` | Set to `false` to disable LLM features entirely and use command-only mode. |

### Capable LLM (complex reasoning — optional)

Currently reserved for future higher-quality reasoning tasks. Falls back to the passive tier if not configured.

| Variable | Default | Description |
|---|---|---|
| `LLM_CAPABLE_PROVIDER` | `openai` | Provider name. |
| `LLM_CAPABLE_BASE_URL` | `https://api.openai.com/v1` | Base URL. Any OpenAI-compatible endpoint works. |
| `LLM_CAPABLE_MODEL` | `gpt-4o-mini` | Model identifier. |
| `LLM_CAPABLE_API_KEY` | *(empty)* | API key. Required for cloud providers. |
| `LLM_CAPABLE_ENABLED` | auto | Enabled automatically if `LLM_CAPABLE_API_KEY` is set. |

> **Legacy variables:** `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_ENABLED` are still read as fallbacks for the capable tier, for backwards compatibility.

### Application

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error`. |
| `MESSAGE_BUFFER_SIZE` | `50` | Number of recent messages kept in memory per conversation for LLM context. Max 500. |
| `STORAGE_DIR` | `storage` | Directory for the Wire SDK's local crypto/session store. |
| `SECRET_MODE_INACTIVITY_MS` | `1800000` | Milliseconds of silence before the bot prompts to exit secret mode (default 30 min). |

---

## What the bot can do

**Tasks** — `task: write the spec` or `we need to write the migration doc`
- Update: `TASK-0001 done` | `cancelled` | `in_progress`
- Reassign: `TASK-0001 reassign to Mark`
- Deadline: `TASK-0001 due Friday`
- List mine: `my tasks` | List team: `team tasks`

**Decisions** — `decision: we're going with Postgres` or `we've decided to use option A`
- List/search: `list decisions` | `decisions about pricing`
- Revoke: `revoke DEC-0001`

**Actions** — `action: John to follow up on contract` or `John should call Schwarz`
- Update: `ACT-0001 done` | `cancelled`
- Reassign: `assign ACT-0001 to Mark`
- Deadline: `ACT-0001 due Friday`
- List mine: `my actions` | Team: `team actions` | Overdue: `overdue actions`

**Reminders** — `remind me at 3pm to call John`
- List: `show reminders` | Cancel: `cancel REM-0001` | Snooze: `snooze REM-0001 1 hour`

**Knowledge** — `remember that Schwarz have 10k users` | say a fact then `remember this`
- Retrieve: `what is our rate limit?`
- Update: `update KB-0001 new text` | Forget: `forget KB-0001`

**Passive capture** — the bot also detects facts and decisions worth recording from natural conversation and asks before storing anything.

**Secret mode** — type `secret mode` to pause the bot. Type `resume` to start listening again.

---

## Architecture

```
src/
  app/               # Config, container wiring, entry point
  domain/            # Entities, repository ports, service ports
  application/       # Use cases, application services
  infrastructure/
    llm/             # OpenAI-compatible adapters (passive + capable tiers)
    persistence/     # Prisma/Postgres repositories
    scheduler/       # In-process job scheduler
    services/        # User resolution, member cache
    wire/            # Wire SDK event router and outbound adapter
```

The bot follows a hexagonal (ports and adapters) architecture. The domain and application layers have no dependency on Wire, Prisma, or any LLM provider. Swap any infrastructure component without touching business logic.

### LLM call budget

With the split model in place, the passive model handles intent classification on every message. The capable model is only invoked for operations that genuinely benefit from higher reasoning quality. In practice, most of the bot's work (fast-path ID commands, exact-match list commands) never touches an LLM at all.

---

## Development

```bash
npm install
cp .env.example .env          # fill in credentials
npx prisma migrate dev        # create the local DB schema
npm run dev                   # start with ts-node watch

npm test                      # run unit + contract tests
npx tsc --noEmit              # type-check without emitting
```

Database migrations live in `prisma/migrations/`. The schema is in `prisma/schema.prisma`.
