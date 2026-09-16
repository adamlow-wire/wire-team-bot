# Migration: wire-team-bot → official `@wireapp/wire-apps-js-sdk`

> Ticket: **WPB-TBD**. Written 2026-09-16 against npm `@wireapp/wire-apps-js-sdk@0.1.0` (upstream `main` @ `0ed4193`).
> Status: **PR 1 and PR 2 implemented on branch `feat/official-wire-apps-js-sdk` (2026-09-16).** Cutover (§7) pending onboarding.

## 1. Goal

Swap the vendored fork (`adamlow-wire/wire-apps-js-sdk` submodule @ `8e308adf`) for the published `@wireapp/wire-apps-js-sdk`, using only its public API, and get to a runnable bot fast. Two PRs plus a cutover. Everything else is appendix.

## 2. Decisions (locked for this pass)

- **Stay CommonJS.** Node 22.22 can `require()` the ESM SDK (verified: no top-level await in its build). `tsc` resolves types via the package's `types` field. ESM conversion is deferred (Appendix A).
- **Base image → `node:22-trixie-slim`.** The SDK's core-crypto is now a native `.so` needing glibc ≥ 2.38, x86-64 only. Alpine (musl) and Debian bookworm (2.36) can't load it. Verified `node:22-trixie-slim` exists.
- **Bot identity from env.** `WIRE_SDK_APP_ID` / `WIRE_SDK_APP_DOMAIN` (known at onboarding), checked against `manager.getApplicationQualifiedId()` after `create()`. Keeps the current construction order (router is built before the SDK).
- **SDK storage stays at `./storage` (cwd).** Matches Docker `WORKDIR /app` + volume `/app/storage` already. Drop the DB-path patch and the `apps.db` plumbing. `STORAGE_DIR` is removed from SDK concerns.
- **Crypto key:** `WIRE_SDK_CRYPTO_KEY` = 64 hex chars (`openssl rand -hex 32`), decoded to a 32-byte `Uint8Array`.
- **Use `getUsers([id])`,** not `getUser` (present in 0.1.0, already removed on upstream `main`).
- **Button confirmation:** send a typed literal (the type isn't exported but `sendMessage` accepts it). One-line upstream PR later.

## 3. API change matrix (the actual work)

| Bot call today (fork) | Official 0.1.0 | File |
|---|---|---|
| `import … from "wire-apps-js-sdk"` | `import … from "@wireapp/wire-apps-js-sdk"` | all 5 infra files + `container.ts` |
| `WireAppSdk.create(email, password, userId, domain, apiHost, cryptoPassword, handler, logger)` | `WireAppSdk.create(apiToken, apiHost, key: Uint8Array(32), handler, logger)` | `WireClient.ts` |
| `import("…/build/db/DatabaseService.js")` + `DEFAULT_DATABASE_PATH = …` | **delete** | `WireClient.ts` |
| `import("…/build/db/ConversationRepository.js")`, `ConversationMemberRepository`, `tsyringe` `container.resolve` | `sdk.getApplicationManager().getAllConversations()` → `Conversation[]`; `.getMembersInConversation(qid)` → `ConversationMember[]` | `container.ts` |
| `hydrateFromSdkStore(rows{id,domain}, getMembers → {user_id,user_domain,role})` | `hydrateFromSdkStore(Conversation[], (c) => Promise<ConversationMember[]>)`; role via `ConversationRole.ADMIN` (`'wire_admin'`) | `WireEventRouter.ts` |
| `manager.getUser(id)` → `{id,name,handle}` | `const [u] = await manager.getUsers([id])` → `WireUser {id, name, handle?, …}` | `WireOutboundAdapter.ts` |
| `CompositeMessage.create({conversationId, items: [{text:{content}}, {button:{id,text}}]})` | `CompositeMessage.create({conversationId, text, itemList: buttons.map(b => CompositeButton.create({id: b.id, text: b.label}))})` | `WireOutboundAdapter.ts` |
| `ReactionMessage.create({conversationId, emoji, targetMessageId})` | `Reaction.create({conversationId, messageId, emojiSet: new Set([emoji])})` | `WireOutboundAdapter.ts` |
| `TextMessage.create({conversationId, text, mentions})` | unchanged | — |
| `manager.sendAsset(convId, {data, name, mimeType})` | unchanged | — |
| `onMessageEdited(m: MessageEditMessage)` | `onTextMessageEdited(m: TextEditedMessage)` | `WireEventRouter.ts` |
| `onButtonActionReceived(m: ButtonActionMessage)` | `onButtonClicked(m: CompositeButtonAction)` (same fields `buttonId`, `referenceMessageId`) | `WireEventRouter.ts` |
| `ButtonActionConfirmationMessage.create({conversationId, referenceMessageId, buttonId})` | literal: `{type: 'composite_button_action_confirmation', id: crypto.randomUUID(), conversationId, referenceMessageId, buttonId}` | `WireEventRouter.ts` |
| `onAppAddedToConversation / onConversationDeleted / onUserJoinedConversation / onUserLeftConversation` | unchanged names and shapes; `conversation.name` is now typed (`string \| null`), drop the cast | `WireEventRouter.ts` |
| `ManagerHandle` hand-rolled interface | `WireApplicationManager` is exported; type against it or keep a 3-method subset (`sendMessage`, `sendAsset`, `getUsers`) | `WireOutboundAdapter.ts` |
| Logger bridge `{debug,info,warn,error}(msg, ...meta)` | identical interface | — |
| `src/types/wire-apps-js-sdk.d.ts` | **delete** (package ships types) | — |
| `QualifiedId` plain `{id, domain}` | now a class; plain objects still assignable when passing in. Never `String(qid)` expecting the raw id (it obfuscates). | — |

Config (`src/app/config.ts`, `.env.example`, README env table):

| Remove | Add |
|---|---|
| `WIRE_SDK_USER_EMAIL`, `WIRE_SDK_USER_PASSWORD`, `WIRE_SDK_USER_ID`, `WIRE_SDK_USER_DOMAIN`, `WIRE_SDK_CRYPTO_PASSWORD` | `WIRE_SDK_API_TOKEN`, `WIRE_SDK_CRYPTO_KEY` (hex, 32 bytes), `WIRE_SDK_APP_ID`, `WIRE_SDK_APP_DOMAIN` |
| `STORAGE_DIR` (SDK path) | — |
| (keep) `WIRE_SDK_API_HOST` | |

`config.wire` becomes `{ apiToken, apiHost, cryptoKey: Uint8Array, appId, appDomain }`. `systemActorId` in `container.ts` reads `appId/appDomain`.

## 4. Prerequisites (ops, before PR 1 can be tested)

1. **Apps feature enabled for the team** on the target backend. wire-server routes: `POST /teams/{tid}/apps` (create), token via `/teams/{tid}/apps/{aid}/cookies`. Needs a team admin. **Hard blocker if unavailable.**
2. Create the "Jeeves" app; record its qualified ID; mint the token.
3. `openssl rand -hex 32` → `WIRE_SDK_CRYPTO_KEY`.
4. Deployment host is linux/x86_64 (no ARM).
5. Fill in the WPB key.

## 5. PR 1 — Library swap + adapters (makes it build and run)

1. `git rm wire-apps-js-sdk`; delete `.gitmodules`; remove `sdk:setup` and `postinstall` from `package.json`.
2. `npm i @wireapp/wire-apps-js-sdk@^0.1.0` (caret on `0.x` = patch-only, good). Remove `reflect-metadata` from deps if nothing else in the bot uses it (the SDK imports it itself).
3. Delete `src/types/wire-apps-js-sdk.d.ts`.
4. Apply the matrix in §3 to `config.ts`, `WireClient.ts`, `WireOutboundAdapter.ts`, `WireEventRouter.ts`, `container.ts`.
5. `container.ts` hydration becomes:
   ```ts
   const m = sdk.getApplicationManager();
   const convs = await m.getAllConversations();
   await router.hydrateFromSdkStore(convs, (c) => m.getMembersInConversation(new QualifiedId(c.id, c.domain)));
   ```
6. `WireClient.ts` post-create check: app ID from manager must equal `config.wire.appId/appDomain`, else throw.
7. Tests:
   - Update `tests/contract/WireOutboundAdapter.contract.test.ts`: composite `items[0]` is a `TextMessage` (`.text`), `items[1..]` are `{type:'composite_button', id, text}`; reaction asserts `messageId` and `emojiSet`.
   - Update `WireEventRouter.contract.test.ts` for the renamed handlers and the new `hydrateFromSdkStore` signature.
   - **Heads-up:** importing the SDK index loads the native core-crypto library at module init. On a glibc < 2.38 machine (this WSL box) `vitest` and the CLI e2e harness will fail to import. Either run `npm test` / `npm run test:e2e` inside the Docker builder stage (or CI on `ubuntu-latest`), or add a `vitest` alias to a tiny stub module for the SDK factories. Pick the Docker route first; it's zero code.
8. Gate: `npm run build` clean; tests green on a glibc ≥ 2.38 host.

## 6. PR 2 — Image, CI, docs (makes it deployable)

- `Dockerfile`: `FROM node:22-trixie-slim` (or `node:22.22.1-trixie-slim` to match the SDK's exact `engines` pin) in both stages. Remove `COPY wire-apps-js-sdk`, the `fix-core-crypto-main.js` step, and the runner-stage SDK copy. Flow stays `npm ci` → `prisma generate` → `npm run build` → `npm prune --omit=dev`. SDK migrations ship in the tarball.
- `.github/workflows/publish-container.yml`: drop `submodules: recursive` and `SUBMODULES_READ_TOKEN`. Add a `test` job (`npm ci && npm run build && npm test`) on `ubuntu-latest`.
- `.env.example`, `README.md` (env table; Requirements: linux/x86_64, glibc ≥ 2.38), `AGENTS.md` and `PLAN_v2.md` (SDK env references, remove the shim from the layout).
- `docker-compose.yml`: note on `jeeves-crypto` that it must be recreated for the migration.

## 7. Cutover checklist

1. List channels Jeeves is in: `SELECT channel_id, channel_name FROM channel_config;`
2. `docker compose down`. Back up `jeeves-crypto` (don't delete). Create a fresh volume: the fork's SQLite schema and MLS client are incompatible with the new app identity.
3. Deploy new image + new `.env`. Postgres untouched (everything keys on conversation IDs).
4. Start. Expect logs: migrations ran, `CoreCrypto initialized`, WS connected, member cache hydrated (0 conversations on first boot).
5. Team admin adds the app to each channel from step 1. Confirm `onAppAddedToConversation` fires; the greeting only appears where `purpose` was never set.
6. Smoke: `decision: …`, `@Jeeves <question>`, `remind me in 2 minutes to …`.
7. **Restart the container, send another message, confirm it decrypts.** This is the regression test for the old "MLS state lost on restart" bug, now fixed by the persistent keystore.
8. 1:1 "personal mode": a user opens a 1:1 with the app and sends a message; confirm `isPersonalMode` flips.
9. Rollback: previous image tag + backed-up volume + old `.env`. The old user-account bot still exists until deleted.

## 7a. Implementation notes (what actually happened)

- **Hidden devDependencies.** `typescript-eslint` and `@types/node` were never declared by the bot; they were hoisted from the fork submodule's devDependencies. Both are now real devDependencies. The redundant wildcard `@typescript-eslint/eslint-plugin` / `parser` entries were dropped (the flat config imports only `typescript-eslint`).
- **Lockfile regenerated with npm 12.** Plain `npm install` under npm 10.9.x dies with `Cannot read properties of null (reading 'edgesOut')` while resolving vitest's peer set. npm 12 resolves the same tree cleanly. `npm ci` with the committed lockfile works on npm 10.
- **`npm ci` + better-sqlite3 13.** The package ships prebuilt binaries and sets `gypfile: false`, but npm 10's `npm ci` takes metadata from the lockfile (which lacks that flag), sees `binding.gyp`, and runs an implicit `node-gyp rebuild` that fails on a toolchain-free image. Fix used in Dockerfile and CI: `npm ci --ignore-scripts && npm rebuild prisma @prisma/client @prisma/engines`. Prisma is the only dependency whose install hooks we need.
- **Stale better-sqlite3 12.8 / prebuild-install** entries inherited from the fork are gone from the lockfile.
- **Verified in `node:22-trixie-slim`:** SDK loads via CommonJS `require()`, full image builds (862 MB), runner stage has the Prisma client and no devDependencies, config validation fails fast on a malformed `WIRE_SDK_CRYPTO_KEY`.
- **Unit tests:** 126 pass in the container. 15 failures across 4 files (`tests/pipeline/OpenAIExtractionAdapter`, `OpenAIQueryAnalysisAdapter`, `ProcessingPipeline`, `tests/retrieval/StructuredRetrievalPath`) are **pre-existing on `main`** and unrelated to the SDK.
- **Lint:** 0 errors, 22 pre-existing warnings, none in touched files.
- **Not exercised yet:** anything requiring a real app token (`WireAppSdk.create`, hydration, message send/receive). That's cutover step 4 onwards.

## 8. Risks

| Risk | Handling |
|---|---|
| Apps feature not enabled | §4 step 1 before writing code |
| Native lib: glibc ≥ 2.38, x86-64 only | trixie image; confirm host arch; local tests via Docker |
| SDK owns `SIGINT/SIGTERM` and calls `process.exit(0)` after `close()`; bot's own `shutdown` races it | Same as today with the fork; acceptable. Follow-up: let SDK own exit, disconnect Prisma in a hook |
| Downtime messages missed | Same class of risk as today; observe during cutover |
| Pre-1.0 upstream churn | `^0.1.0` pins to patches; bump deliberately |

## 9. Open questions

1. WPB key?
2. Apps feature on for the team, and who's team admin?
3. Deployment host arch confirmed x86_64?
4. Anyone need `STORAGE_DIR` to keep working? (If yes: `process.chdir()` before `create()`.)

---

## Appendix A — ESM conversion (deferred)

Upstream calls CJS consumption unsupported, so this is real tech debt, just not blocking. Measured cost: 521 extension-less relative imports across 129 files (codemod: append `.js`), 8 `__dirname` uses all in `tests/` (→ `import.meta.dirname`), zero `require()` calls, `ts-node` → `tsx`. `"type": "module"`, `module`/`moduleResolution: nodenext`. About half a day to a day.

## Appendix B — Fork retirement and upstream follow-ups

- Tag the fork branch `feature/ui-component-support` as `wire-team-bot-last-fork-pin`, then archive.
- Upstream PRs: export `CompositeButtonActionConfirmation`; configurable storage root via `create()` options; musl and linux-aarch64 builds of `libcore_crypto_ffi` (core-crypto repo).
- Sibling consumer `apps/openclaw-wire/plugin-wire` still uses a vendored fork tarball; separate ticket, same playbook.
- Fork-only behaviour and its upstream status: WS reconnect and 429 retry are merged/present upstream; serializer sender fixes superseded by CoreCrypto-derived sender; MLS restart fixes superseded by the persistent keystore; `getUser` → `getUsers`; TeamInvite event and `ConversationException` were never used by the bot.
