/**
 * E2E test runner for Wire Team Bot — answer judging plus stored-fact checks.
 *
 * Each step spawns `node dist/app/cli.js` with piped input and captures stdout.
 * Step and scenario assertions are evaluated by an LLM judge rather than regex.
 *
 * Isolation: every scenario receives a unique E2E_CHANNEL_ID so its data is
 * scoped to its own DB conversation.  Re-running the suite uses a fresh
 * suiteRunId so there is no cross-run contamination.
 *
 * Usage:
 *   npm run test:e2e
 *   npm run test:e2e -- --filter TC-DEC     # run only decision tests
 *   npm run test:e2e -- --verbose           # show full output + judge reasoning
 *   npm run test:e2e -- --bail              # stop after first failure
 */

import { createInterface } from "node:readline";
import { PrismaClient } from "@prisma/client";
import { checkStoredRecords, type ExpectedRecord, type StoredRecord } from "./storedRecords";
import { exactReplyMatches } from "./replyChecks";
import type { EvaluationContext, JudgeResult } from "./judge";
import { spawn }   from "child_process";
import fs          from "fs";
import path        from "path";
import { judge }   from "./judge";
import { scenarios } from "./scenarios";

const ROOT = path.resolve(__dirname, "../..");
const CLI  = path.join(ROOT, "dist/app/cli.js");

const args    = process.argv.slice(2);
const filter  = args.find(a => a.startsWith("--filter="))?.split("=")[1]
             ?? (args.includes("--filter") ? args[args.indexOf("--filter") + 1] : null);
const verbose = args.includes("--verbose");
const bail    = args.includes("--bail");
const jsonOut = args.includes("--json");

/**
 * Unique identifier for this suite run.  Injected into every spawned CLI
 * process as part of E2E_CHANNEL_ID so each scenario's DB writes are
 * isolated from other scenarios and from previous suite runs.
 */
const suiteRunId = Date.now().toString(36);
const prisma = new PrismaClient();

// ── Public types (imported by scenarios.ts) ───────────────────────────────────

export interface Step {
  /** Message to send. Use {{DEC}}, {{ACT}}, {{REM}} for IDs; lowercase placeholders test lowercase input. */
  input: string;
  /**
   * After this step, capture the first matching ID into the named slot.
   * e.g. captureAs: "DEC" captures the first DEC-NNNN from the response.
   */
  captureAs?: "DEC" | "ACT" | "REM";
  /** Plain-English assertion evaluated by the LLM judge. */
  assert?: string;
  /** Exact assertion for deterministic command output; stored facts are checked separately. */
  replyEquals?: string;
  /**
   * When true, this step shares a CLI process with the immediately preceding step.
   * Use for follow-up / context-dependent exchanges where conversation state must
   * persist between messages.
   */
  shareProcess?: boolean;
}

export interface Scenario {
  id: string;
  description: string;
  /** Optional fixed parser clock; never freezes network or scheduler timers. */
  referenceTime?: string;
  timezone?: string;
  /** Exact post-drain inventory expectations, including silent captures. */
  stored?: ExpectedRecord[];
  channelState?: "active" | "paused" | "secure";
  /**
   * Either a flat array of string inputs (context-only steps with no assertion),
   * or Step objects for steps that need assertions or ID capture.
   */
  steps: (string | Step)[];
  /** Assertion applied to the combined output of all steps. */
  assert?: string;
}

// ── ID capture ────────────────────────────────────────────────────────────────

const ID_PATTERNS: Record<string, RegExp> = {
  DEC: /DEC-\d+/i,
  ACT: /ACT-\d+/i,
  REM: /REM-\d+/i,
};

function applyCaptures(input: string, captures: Record<string, string>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (_, key) => captures[key] ?? `{{${key}}}`);
}

// ── Scenario runner ───────────────────────────────────────────────────────────

interface Judgement { step: string; assertion: string; result: JudgeResult }

interface StepFailure {
  step: string;
  assertion: string;
  reason: string;
  botOutput: string;
}

/**
 * Build the per-scenario env so every CLI process for scenario `id` writes to
 * an isolated DB conversation.  The suiteRunId suffix prevents cross-run
 * contamination when the suite is run multiple times against the same database.
 */
function scenarioEnv(scenarioId: string, context: EvaluationContext): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    LOG_LEVEL: "warn",
    E2E_CHANNEL_ID: `e2e-${scenarioId}-${suiteRunId}`,
    E2E_REFERENCE_TIME: context.referenceTime,
    E2E_TIMEZONE: context.timezone,
  };
}

async function runScenario(
  scenario: Scenario,
): Promise<{ passed: boolean; stepOutputs: string[]; failures: StepFailure[]; context: EvaluationContext; events: SourceEvent[]; records: StoredRecord[]; channelState: string | null; storedChecks: string[] | null; judgements: Judgement[] }> {
  const normalised: Step[] = scenario.steps.map(s =>
    typeof s === "string" ? { input: s } : s,
  );

  const captures: Record<string, string> = {};
  const stepOutputs: string[] = [];
  const failures: StepFailure[] = [];
  const judgements: Judgement[] = [];
  const context = { referenceTime: scenario.referenceTime ?? new Date().toISOString(), timezone: scenario.timezone ?? "UTC" };
  const env = scenarioEnv(scenario.id, context);
  const events: SourceEvent[] = [];

  let pendingSharedInputs: SourceEvent[] = [];
  let pendingSharedSteps: Step[] = [];

  const flushShared = async () => {
    if (pendingSharedInputs.length === 0) return;
    const outputs = await runMultiLine(pendingSharedInputs, env);
    for (let i = 0; i < pendingSharedSteps.length; i++) {
      const stepOut = outputs[i] ?? "";
      stepOutputs.push(stepOut);
      const step = pendingSharedSteps[i]!;
      if (step.captureAs) {
        const match = ID_PATTERNS[step.captureAs]?.exec(stepOut);
        if (match) {
          captures[step.captureAs] = match[0];
          captures[step.captureAs.toLowerCase()] = match[0].toLowerCase();
        } else {
          process.stderr.write(
            `  ⚠  captureAs "${step.captureAs}" found no ID in response for: "${step.input.slice(0, 60)}"\n`,
          );
        }
      }
      if (step.replyEquals !== undefined) {
        const expected = applyCaptures(step.replyEquals, captures);
        if (!exactReplyMatches(stepOut, expected)) failures.push({ step: step.input, assertion: expected,
          reason: "Deterministic reply differs from the exact expected confirmation/list", botOutput: stepOut });
      }
      if (step.assert) {
        const assertion = applyCaptures(step.assert, captures);
        const result = await judge(stepOut, assertion, context);
        judgements.push({ step: pendingSharedInputs[i].text, assertion, result });
        if (!result.pass) {
          failures.push({ step: step.input.slice(0, 60), assertion, reason: result.reason, botOutput: stepOut });
        } else if (verbose) {
          process.stdout.write(`    [judge] PASS — ${result.reason}\n`);
        }
      }
    }
    pendingSharedInputs = [];
    pendingSharedSteps = [];
  };

  for (const [index, step] of normalised.entries()) {
    // Flush before substitution so IDs captured by preceding shared steps exist.
    if (!step.shareProcess) await flushShared();
    const resolvedInput = applyCaptures(step.input, captures);
    const event = { eventId: `${scenario.id}-step-${index + 1}`, text: resolvedInput };
    events.push(event);

    if (step.shareProcess) {
      pendingSharedInputs.push(event);
      pendingSharedSteps.push(step);
      continue;
    }

    const output = await runOneLine(event, env);
    stepOutputs.push(output);

    // Capture a reference ID from this step's output if requested
    if (step.captureAs) {
      const match = ID_PATTERNS[step.captureAs]?.exec(output);
      if (match) {
        captures[step.captureAs] = match[0];
        captures[step.captureAs.toLowerCase()] = match[0].toLowerCase();
      } else {
        process.stderr.write(
          `  ⚠  captureAs "${step.captureAs}" found no ID in response for: "${resolvedInput.slice(0, 60)}"\n`,
        );
      }
    }

    if (step.replyEquals !== undefined) {
      const expected = applyCaptures(step.replyEquals, captures);
      if (!exactReplyMatches(output, expected)) failures.push({ step: resolvedInput, assertion: expected,
        reason: "Deterministic reply differs from the exact expected confirmation/list", botOutput: output });
    }

    // Per-step assertion — substitute captured IDs into the assertion text too
    if (step.assert) {
      const assertion = applyCaptures(step.assert, captures);
      const result = await judge(output, assertion, context);
      judgements.push({ step: resolvedInput, assertion, result });
      if (!result.pass) {
        failures.push({
          step: resolvedInput.slice(0, 60),
          assertion,
          reason: result.reason,
          botOutput: output,
        });
      } else if (verbose) {
        process.stdout.write(`    [judge] PASS — ${result.reason}\n`);
      }
    }
  }

  // Flush any remaining shared steps
  await flushShared();

  // Whole-scenario assertion
  if (scenario.assert) {
    const combined = stepOutputs.join("\n");
    const result = await judge(combined, scenario.assert, context);
    judgements.push({ step: "(overall)", assertion: scenario.assert, result });
    if (!result.pass) {
      failures.push({
        step: "(overall)",
        assertion: scenario.assert,
        reason: result.reason,
        botOutput: combined,
      });
    } else if (verbose) {
      process.stdout.write(`    [judge] PASS (overall) — ${result.reason}\n`);
    }
  }

  const scope = { conversationId: env.E2E_CHANNEL_ID, conversationDom: "cli.local" };
  const [decisions, actions, reminders, channel] = await Promise.all([
    prisma.decision.findMany({ where: scope }), prisma.action.findMany({ where: scope }), prisma.reminder.findMany({ where: scope }),
    prisma.channelConfig.findUnique({ where: { channelId: `${scope.conversationId}@${scope.conversationDom}` } }),
  ]);
  const records: StoredRecord[] = [
    ...decisions.map(d => ({ type: "decision" as const, source: d.rawMessageId, content: d.summary,
      author: `${d.authorId}@${d.authorDom}`, decidedBy: d.decidedBy, status: d.status })),
    ...actions.map(a => ({ type: "action" as const, source: a.rawMessageId, content: a.description,
      owner: `${a.assigneeId}@${a.assigneeDom}`, deadline: a.deadline?.toISOString() ?? null, status: a.status })),
    ...reminders.map(r => ({ type: "reminder" as const, source: r.rawMessageId, content: r.description,
      owner: `${r.targetId}@${r.targetDom}`, deadline: r.triggerAt.toISOString(), status: r.status })),
  ];
  const storedChecks = scenario.stored === undefined ? (scenario.channelState ? [] : null)
    : checkStoredRecords(records, scenario.stored, events.map(e => e.eventId));
  const channelState = channel?.state ?? null;
  if (scenario.channelState && channelState !== scenario.channelState) {
    storedChecks!.push(`Expected durable channel state ${scenario.channelState}; found ${channelState}`);
  }
  for (const reason of storedChecks ?? []) failures.push({ step: "(stored records)",
    assertion: "Post-drain inventory must match expected facts, source events, identities and dates exactly",
    reason, botOutput: "" });
  return { passed: failures.length === 0, stepOutputs, failures, context, events, records, channelState, storedChecks, judgements };
}

// ── CLI process spawner ───────────────────────────────────────────────────────

/** Responses are framed by completed source event, after the processing queue drains. */
interface SourceEvent { eventId: string; text: string }

async function runOneLine(input: SourceEvent, env: Record<string, string>): Promise<string> {
  return (await runMultiLine([input], env))[0] ?? "";
}

async function runMultiLine(inputs: SourceEvent[], env: Record<string, string>): Promise<string[]> {
  const proc = spawn("node", [CLI], { cwd: ROOT, env: { ...env, E2E_JSON: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<number | null>(resolve => { proc.once("close", resolve); proc.once("error", () => resolve(-1)); });
  const reader = createInterface({ input: proc.stdout });
  const iterator = reader[Symbol.asyncIterator]();
  const outputs: string[] = [];
  proc.stderr.resume();
  try {
    for (const input of inputs) {
      const eventId = input.eventId;
      proc.stdin.write(JSON.stringify(input) + "\n");
      let timer: NodeJS.Timeout | undefined;
      try {
        const next = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("CLI event timed out")), 240_000); }),
        ]);
        if (next.done) throw new Error("CLI exited before completing the event");
        const result = JSON.parse(next.value) as { eventId: string; replies: string[] };
        if (result.eventId !== eventId) throw new Error("CLI event mismatch");
        outputs.push(result.replies.join("\n"));
      } finally { clearTimeout(timer); }
    }
    proc.stdin.end();
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([closed, new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error("CLI shutdown timed out")), 15_000);
      })]);
      if (code !== 0) throw new Error(`CLI exited with code ${code}`);
    } finally { clearTimeout(closeTimer); }
    return outputs;
  } finally {
    proc.stdin.end();
    reader.close();
    proc.kill();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── JSON result types (also used by --json output mode) ──────────────────────

interface ScenarioResult {
  id: string;
  description: string;
  passed: boolean;
  elapsedMs: number;
  /** Preserve successful synthetic replies too, so judge verdicts can be reviewed. */
  outputs: string[];
  context: EvaluationContext;
  events: SourceEvent[];
  records: StoredRecord[];
  channelState: string | null;
  storedChecks: string[] | null;
  judgements: Judgement[];
  failures: Array<{ step: string; assertion: string; judgeReason: string; botOutput: string }>;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Pre-flight: catch common setup problems and give the agent a clear action.
  if (!fs.existsSync(CLI)) {
    console.error(`\n  ✗  CLI binary not found: ${CLI}`);
    console.error(`     Build first:  npm run build\n`);
    process.exit(1);
  }
  if (!process.env.WIRE_TEAM_BOT_LLM_BASE_URL) {
    console.error(`\n  ✗  WIRE_TEAM_BOT_LLM_BASE_URL is not set`);
    console.error(`     Add it to your .env file — see AGENTS.md §2.4\n`);
    process.exit(1);
  }

  const toRun = filter
    ? scenarios.filter(s => s.id.includes(filter) || s.description.toLowerCase().includes(filter.toLowerCase()))
    : scenarios;

  if (toRun.length === 0) {
    console.error(`No scenarios match filter: ${filter}`);
    process.exit(1);
  }

  if (!jsonOut) {
    console.log(`\nWire Team Bot E2E — running ${toRun.length} scenario(s)  [run: ${suiteRunId}]\n${"─".repeat(70)}`);
  }

  let passed = 0;
  let failed = 0;
  const jsonResults: ScenarioResult[] = [];

  for (const scenario of toRun) {
    process.stderr.write(`Running ${scenario.id}\n`);
    if (!jsonOut) {
      process.stdout.write(`  ${scenario.id.padEnd(16)} ${scenario.description.padEnd(50)} `);
    }
    const scenarioStart = Date.now();
    const result = await runScenario(scenario);
    const elapsedMs = Date.now() - scenarioStart;
    const elapsed = (elapsedMs / 1000).toFixed(1);

    // Collect per-failure details including the actual bot output for that step
    const failures: ScenarioResult["failures"] = result.failures.map(f => ({
      step:        f.step,
      assertion:   f.assertion,
      judgeReason: f.reason,
      botOutput: f.botOutput,
    }));

    if (result.passed) {
      if (!jsonOut) console.log(`✓ PASS  (${elapsed}s)`);
      passed++;
    } else {
      if (!jsonOut) {
        console.log(`✗ FAIL  (${elapsed}s)`);
        for (const f of result.failures) {
          console.log(`    └ step:   ${f.step}`);
          console.log(`      assert: ${f.assertion}`);
          console.log(`      reason: ${f.reason}`);
        }
        // Always show bot output on failure — essential for diagnosing what went wrong
        const rawOutput = result.stepOutputs.join("\n").trim();
        if (rawOutput) {
          const lines = rawOutput.split("\n").filter(Boolean);
          console.log(`    Bot output (${lines.length} line(s)):`);
          for (const line of lines) console.log(`      │ ${line}`);
        } else {
          console.log(`    Bot output: (empty — the bot produced no stdout)`);
          console.log(`    Tip: run with LOG_LEVEL=debug to see pipeline trace on stderr`);
        }
      }
      failed++;
    }

    if (jsonOut) {
      jsonResults.push({ id: scenario.id, description: scenario.description, passed: result.passed, elapsedMs, outputs: result.stepOutputs, context: result.context, events: result.events, records: result.records, channelState: result.channelState, storedChecks: result.storedChecks, judgements: result.judgements, failures });
    } else if (verbose && result.passed) {
      const lines = result.stepOutputs.join("\n").trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        console.log(`    Output (${lines.length} line(s)):`);
        for (const line of lines) console.log(`      │ ${line}`);
      }
    }

    if (bail && failed > 0) {
      if (!jsonOut) console.log("\n  --bail: stopping after first failure.");
      break;
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify({ runId: suiteRunId, judgeModel: process.env.WIRE_TEAM_BOT_JUDGE_MODEL ?? process.env.WIRE_TEAM_BOT_MODEL_CLASSIFY, passed, failed, scenarios: jsonResults }, null, 2));
  } else {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`  ${passed} passed, ${failed} failed\n`);
  }
  await prisma.$disconnect();
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(async err => { console.error(err); await prisma.$disconnect(); process.exitCode = 1; });
