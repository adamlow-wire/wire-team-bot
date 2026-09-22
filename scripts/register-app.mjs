#!/usr/bin/env node
/**
 * Register (or re-authenticate) Wire Team Bot as a Wire *application* on a Wire backend
 * and emit the WIRE_SDK_* environment block the bot needs.
 *
 * The Wire Apps SDK authenticates with an app token, which is the `zuid` cookie the
 * backend returns from POST /teams/{tid}/apps (create) or
 * POST /teams/{tid}/apps/{app}/cookies (refresh). A team admin must run this.
 *
 * Usage:
 *   node scripts/register-app.mjs versions  --host URL
 *   node scripts/register-app.mjs send-code --host URL --email ADMIN_EMAIL
 *   node scripts/register-app.mjs create    --host URL --email ADMIN_EMAIL [--name "Wire Team Bot"] [--category other]
 *                                           [--description TEXT] [--code 2FA_CODE] [--out .env.staging] [--force]
 *   node scripts/register-app.mjs refresh   --host URL --email ADMIN_EMAIL --app-id UUID [--code 2FA_CODE] [--out FILE]
 *   node scripts/register-app.mjs list      --host URL --email ADMIN_EMAIL [--code 2FA_CODE]
 *
 * Env fallbacks: WIRE_SDK_API_HOST (host), WIRE_ADMIN_EMAIL, WIRE_ADMIN_PASSWORD.
 * The admin password is prompted (hidden) when not supplied via env; it is never echoed or logged.
 * Tokens are masked on stdout unless --print-token is given; use --out to write them to a 0600 file.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

// The Wire Apps SDK itself talks to the backend at v15; use the same version when the
// backend offers it so this script and the bot agree on API semantics.
const PREFERRED_API_VERSION = 15;
const MIN_API_VERSION = 15; // create-app needs V12; list-apps needs V15

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) fail(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i++;
    }
  }
  return { command, opts };
}

function fail(msg, code = 1) {
  stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function usage() {
  stdout.write(`Usage:
  node scripts/register-app.mjs versions  --host URL
  node scripts/register-app.mjs send-code --host URL --email ADMIN_EMAIL
  node scripts/register-app.mjs create    --host URL --email ADMIN_EMAIL [--name "Wire Team Bot"] [--category other]
                                          [--description TEXT] [--code 2FA_CODE] [--out FILE] [--force] [--print-token]
  node scripts/register-app.mjs refresh   --host URL --email ADMIN_EMAIL --app-id UUID [--code 2FA_CODE] [--out FILE] [--force] [--print-token]
  node scripts/register-app.mjs list      --host URL --email ADMIN_EMAIL [--code 2FA_CODE]

Env fallbacks: WIRE_SDK_API_HOST, WIRE_ADMIN_EMAIL, WIRE_ADMIN_PASSWORD.
Staging host: https://staging-nginz-https.zinfra.io
`);
}

// ── Prompting ────────────────────────────────────────────────────────────────

async function promptHidden(question) {
  if (!stdin.isTTY) fail("Password required: set WIRE_ADMIN_PASSWORD (no TTY available for a prompt)");
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // Suppress echo by overriding the internal write while the question is pending.
  const origWrite = rl._writeToOutput;
  rl._writeToOutput = (s) => {
    if (s.includes(question)) origWrite.call(rl, question);
  };
  try {
    const answer = await rl.question(question);
    stdout.write("\n");
    return answer;
  } finally {
    rl.close();
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, label, message, body) {
    super(`${status} ${label ?? ""} ${message ?? ""}`.trim());
    this.status = status;
    this.label = label;
    this.body = body;
  }
}

async function api(host, path, { method = "GET", token, body, cookie } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = `zuid=${cookie}`;
  const res = await fetch(`${host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new ApiError(res.status, data?.label, data?.message, data);
  return { data, res };
}

async function negotiateVersion(host) {
  const { data } = await api(host, "/api-version");
  const supported = Array.isArray(data?.supported) ? data.supported : [];
  const max = Math.max(...supported);
  if (!Number.isFinite(max) || max < MIN_API_VERSION) {
    fail(`Backend at ${host} supports API versions [${supported.join(",")}]; need >= ${MIN_API_VERSION} for the apps API`);
  }
  const chosen = supported.includes(PREFERRED_API_VERSION) ? PREFERRED_API_VERSION : max;
  return { version: `v${chosen}`, domain: data.domain, federation: data.federation, supported };
}

async function login(host, v, email, password, code) {
  const body = { email, password, label: "wire-team-bot-register-app" };
  if (code) body.verification_code = String(code);
  try {
    const { data } = await api(host, `/${v}/login?persist=false`, { method: "POST", body });
    return data.access_token;
  } catch (e) {
    if (e instanceof ApiError && e.label === "code-authentication-required") {
      fail(
        "This account requires a second factor. Run:\n" +
          `  node scripts/register-app.mjs send-code --host ${host} --email ${email}\n` +
          "then retry with --code <code from email>.",
      );
    }
    if (e instanceof ApiError && e.label === "code-authentication-failed") fail("Verification code rejected (expired or wrong).");
    if (e instanceof ApiError && e.status === 403) fail(`Login failed: ${e.message}`);
    throw e;
  }
}

async function self(host, v, token) {
  const { data } = await api(host, `/${v}/self`, { token });
  if (!data.team) fail("The admin account is not a member of a team; apps are owned by teams.");
  return { teamId: data.team, domain: data.qualified_id?.domain, userId: data.qualified_id?.id };
}

/** Prove the app token works the way the SDK will use it: POST /access with Cookie zuid=<token>. */
async function verifyAppToken(host, v, cookie) {
  try {
    const { data } = await api(host, `/${v}/access`, { method: "POST", cookie });
    if (!data?.access_token) fail("Token check: /access returned no access_token");
    stdout.write(`Token check: OK (app user ${data.user}).\n`);
  } catch (e) {
    fail(`Token check failed: ${e.message}. Not writing anything.`);
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

function mask(secret) {
  if (!secret) return "";
  return secret.length <= 12 ? "********" : `${secret.slice(0, 6)}…${secret.slice(-4)} (${secret.length} chars)`;
}

function envBlock({ host, token, appId, appDomain, cryptoKey }) {
  const lines = [
    `WIRE_SDK_API_HOST=${host}`,
    `WIRE_SDK_APP_ID=${appId}`,
    `WIRE_SDK_APP_DOMAIN=${appDomain}`,
    `WIRE_SDK_API_TOKEN=${token}`,
  ];
  if (cryptoKey) lines.push(`WIRE_SDK_CRYPTO_KEY=${cryptoKey}`);
  return lines.join("\n") + "\n";
}

function emit(result, opts) {
  const block = envBlock(result);
  if (opts.out) {
    if (existsSync(opts.out) && !opts.force) fail(`${opts.out} exists; pass --force to overwrite`);
    writeFileSync(opts.out, block, { mode: 0o600 });
    stdout.write(`Wrote ${opts.out} (mode 0600).\n`);
  }
  const shown = opts["print-token"]
    ? block
    : block
        .replace(/^(WIRE_SDK_API_TOKEN=)(.*)$/m, (_, k, val) => `${k}${mask(val)}`)
        .replace(/^(WIRE_SDK_CRYPTO_KEY=)(.*)$/m, (_, k, val) => `${k}${mask(val)}`);
  stdout.write("\n" + shown + "\n");
  if (!opts.out && !opts["print-token"]) {
    stdout.write("Secrets are masked. Re-run with --out FILE to save them, or --print-token to show them.\n");
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function withAdmin(host, opts) {
  const { version, domain } = await negotiateVersion(host);
  const email = opts.email ?? process.env.WIRE_ADMIN_EMAIL;
  if (!email) fail("--email (or WIRE_ADMIN_EMAIL) is required");
  const password = process.env.WIRE_ADMIN_PASSWORD ?? (await promptHidden(`Wire password for ${email}: `));
  if (!password) fail("Password is required");
  const token = await login(host, version, email, password, opts.code);
  const me = await self(host, version, token);
  return { v: version, backendDomain: domain, token, password, ...me };
}

async function cmdVersions(host) {
  const info = await negotiateVersion(host);
  stdout.write(`host:       ${host}\ndomain:     ${info.domain}\nfederation: ${info.federation}\nsupported:  ${info.supported.join(",")}\nusing:      ${info.version}\n`);
}

async function cmdSendCode(host, opts) {
  const { version } = await negotiateVersion(host);
  const email = opts.email ?? process.env.WIRE_ADMIN_EMAIL;
  if (!email) fail("--email (or WIRE_ADMIN_EMAIL) is required");
  await api(host, `/${version}/verification-code/send`, { method: "POST", body: { email, action: "login" } });
  stdout.write(`Verification code sent to ${email}. Re-run create/refresh/list with --code <code>.\n`);
}

async function cmdCreate(host, opts) {
  const a = await withAdmin(host, opts);
  const name = opts.name ?? "Wire Team Bot";
  const body = {
    name,
    category: opts.category ?? "other",
    description: (opts.description ?? "Wire Team Bot — team assistant bot (decisions, actions, reminders, Q&A).").slice(0, 300),
    password: a.password,
  };
  let created;
  try {
    ({ data: created } = await api(host, `/${a.v}/teams/${a.teamId}/apps`, { method: "POST", token: a.token, body }));
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
      fail(`Creating the app failed (${e.message}). You need team admin/owner rights and the apps feature must be enabled for the team.`);
    }
    throw e;
  }
  const appId = created?.user?.qualified_id?.id;
  const appDomain = created?.user?.qualified_id?.domain ?? a.domain;
  const cookie = created?.cookie;
  if (!appId || !cookie) fail(`Unexpected create-app response: ${JSON.stringify(Object.keys(created ?? {}))}`);
  stdout.write(`Created app "${created.user?.name ?? name}" in team ${a.teamId}.\n`);
  await verifyAppToken(host, a.v, cookie);
  emit({ host, token: cookie, appId, appDomain, cryptoKey: randomBytes(32).toString("hex") }, opts);
  stdout.write(
    "\nNext: start the bot with this env, then have a team admin add the app to a conversation.\n" +
      "WIRE_SDK_CRYPTO_KEY is freshly generated for this new identity; keep it with the token.\n",
  );
}

async function cmdRefresh(host, opts) {
  const appId = opts["app-id"];
  if (!appId) fail("--app-id is required for refresh");
  const a = await withAdmin(host, opts);
  const { data } = await api(host, `/${a.v}/teams/${a.teamId}/apps/${appId}/cookies`, {
    method: "POST",
    token: a.token,
    body: { password: a.password },
  });
  if (!data?.cookie) fail("Unexpected refresh response (no cookie)");
  stdout.write(`Issued a new token for app ${appId}. Restart the bot with it.\n`);
  await verifyAppToken(host, a.v, data.cookie);
  emit({ host, token: data.cookie, appId, appDomain: a.domain }, opts);
  stdout.write("\nNo WIRE_SDK_CRYPTO_KEY emitted: keep the existing key so the existing crypto store still opens.\n");
}

async function cmdList(host, opts) {
  const a = await withAdmin(host, opts);
  const { data } = await api(host, `/${a.v}/teams/${a.teamId}/apps`, { token: a.token });
  if (!Array.isArray(data) || data.length === 0) {
    stdout.write(`No apps owned by team ${a.teamId}.\n`);
    return;
  }
  for (const app of data) {
    stdout.write(`${app.qualified_id?.id}@${app.qualified_id?.domain}  ${app.name}${app.deleted ? "  (deleted)" : ""}\n`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const { command, opts } = parseArgs(process.argv.slice(2));
if (!command || command === "--help" || command === "-h" || opts.help) {
  usage();
  process.exit(command ? 0 : 1);
}
const host = (opts.host ?? process.env.WIRE_SDK_API_HOST ?? "").replace(/\/+$/, "");
if (!host) fail("--host (or WIRE_SDK_API_HOST) is required, e.g. https://staging-nginz-https.zinfra.io");

const commands = { versions: cmdVersions, "send-code": cmdSendCode, create: cmdCreate, refresh: cmdRefresh, list: cmdList };
const run = commands[command];
if (!run) {
  usage();
  fail(`Unknown command: ${command}`);
}
run(host, opts).catch((e) => {
  if (e instanceof ApiError) fail(`${e.message}${e.body?.label ? ` [${e.body.label}]` : ""}`);
  fail(e?.message ?? String(e));
});
