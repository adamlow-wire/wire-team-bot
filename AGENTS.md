# AGENTS.md — Contributor guidance

Read [PLAN.md](PLAN.md) first. It is the single source of truth for the app, architecture,
release scope and progress. [README.md](README.md) owns setup and operations. Do not create
parallel versioned plans, feature checklists or gap backlogs. Update PLAN.md as evidence changes.

## Scope and architecture

- Prefer small changes that fix a demonstrated user problem or close a release gate in PLAN.md.
  Do not import old-branch subsystems merely because they exist.
- Preserve the existing hexagonal layout: domain depends only on domain; application depends
  on domain and ports; infrastructure implements adapters; app is the composition root.
- Put entities/repository contracts in `src/domain/`, ports in `src/application/ports/`, use cases
  in `src/application/usecases/`, adapters in `src/infrastructure/`, wiring in `src/app/container.ts`.
- Application code must not call Wire, Prisma or LLM clients directly.
- Match existing TypeScript/style conventions. Keep one concern per module and explicit types.
- No new dependencies unless the user or PLAN.md explicitly requests them. A deferred item in
  the plan is not authorisation to implement it.
- If implementation would contradict the plan, resolve the discrepancy before coding. A user
  request to revise/consolidate the plan authorises those documentation changes.

## Data and safety

- Secrets come from environment variables through `src/app/config.ts`; never commit credentials.
- Extract-and-forget is a requirement, not an assumed property of every current code path.
  Do not persist raw surrounding conversation text, including in signals, logs or audit data.
  See PLAN.md for the known gaps; do not repeat the old blanket privacy guarantees.
- Validate model output, bounds, identities and transitions before writes. Audit domain
  create/update/delete operations through `AuditLogRepository`.
- Enforce qualified conversation scope (ID and domain), including direct record-ID retrieval
  and mutations. Cross-channel/personal org-wide retrieval is outside the pilot.
- PAUSED/SECURE processing must account for both context buffers and queued/in-flight jobs.
- Match embedding model output, fallback output and the database column before enabling vector
  features. Configuration alone does not migrate the schema or validate dimensions.
- Never reset a shared or real-team database to make tests pass. Use isolated test data.

## Validation

For documentation-only changes, check links, references, commands against `package.json`, and
consistency with the inspected code. Runtime tests are not required unless runtime files change.
Do not report historical results as a fresh run.

For code changes:

- New use cases and non-trivial logic need corresponding tests. Unit tests use mocked ports,
  no DB/network/SDK. Follow `tests/usecases/`, `tests/pipeline/` and `tests/retrieval/` conventions.
- Contract tests exercise Wire event routing and outbound mapping in `tests/contract/`.
- Run `npm test`, `npx tsc --noEmit`, `npm run lint`. DB integration tests require
  `INTEGRATION_TESTS=1` and isolated Postgres + pgvector.
- Before claiming behaviour works, build and validate relevant journeys with the CLI/e2e
  harness (real DB and LLM). Wire transport/client UI also needs a real Wire smoke test.
  If infrastructure is unavailable, record the blocked check and do not mark the gate passed.

### CLI and e2e

```bash
npm run build
npm run cli
npm run test:e2e -- --bail
npm run test:e2e -- --filter TC-DEC-03
npm run test:e2e -- --verbose
npm run test:e2e -- --json
```

CLI members are Alice (default), Bob, Carol and Dave. Prefix a line with `Bob: ` to change
sender. Stdout contains bot replies; logs go to stderr. `LOG_LEVEL=debug` enables diagnostics;
use synthetic conversations and avoid committing output containing private information.

Scenarios in `tests/e2e/scenarios.ts` use plain-English assertions evaluated by `judge.ts`,
exact `replyEquals` checks for configured deterministic responses, and post-exit `stored`
expectations matched by source step, fact and qualified identity/date. Preserve zero-capture
negative cases and reject extra/duplicate records. The report retains all inventories and judge
verdicts, including malformed attempts; a model PASS cannot override a deterministic failure.
Before acceptance, run `node node_modules/ts-node/dist/bin.js --transpile-only tests/e2e/calibrateJudge.ts`
with the judge override in PLAN.md. Both positive and deliberately wrong answers must calibrate.
`WIRE_TEAM_BOT_JUDGE_MODEL` falls back to `WIRE_TEAM_BOT_MODEL_CLASSIFY`. Scenarios use isolated conversation
IDs (`e2e-<id>-<runId>`). `captureAs: "DEC" | "ACT" | "REM"` captures IDs for subsequent
`{{DEC}}`, `{{ACT}}`, `{{REM}}` substitutions. Use the existing shared-process support for
context-dependent follow-ups.

On failure, inspect the input, substituted assertion, judge reason and full bot output.
Reproduce the single scenario, fix the cause, rebuild, rerun that scenario, then run the full
e2e regression. Empty output suggests routing/errors or low-signal classification; wrong
person suggests sender/assignee plumbing. Inspect raw results before accepting a judge verdict.
Do not weaken assertions just to pass a regression.

The pilot journeys and acceptance thresholds live in PLAN.md §5; keep their progress there.

### Simulation

```bash
npm run build
npm run simulate
npm run simulate:review
```

The multi-day replay writes `tests/simulation/simulation-report.json`. Human review produces
`tests/simulation/golden.json`, including false positives and missed captures. Check its actual
contents before claiming measured extraction quality; record review status in PLAN.md.
Run the simulation after classifier, extractor or pipeline changes. It complements e2e routing
and answer tests; it does not replace them.

Native Wire SDK requirements can prevent local CLI/tests from loading. See README's dependency
notes for the container route. Record the actual validation environment with results.
