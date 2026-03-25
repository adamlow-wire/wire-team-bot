/**
 * E2E test runner for Jeeves — LLM-as-judge edition.
 *
 * Each step spawns `node dist/app/cli.js` with piped input and captures stdout.
 * Step and scenario assertions are evaluated by an LLM judge rather than regex.
 *
 * Usage:
 *   npm run test:e2e
 *   npm run test:e2e -- --filter TC-DEC     # run only decision tests
 *   npm run test:e2e -- --verbose           # show full output + judge reasoning
 */

import { spawn }   from "child_process";
import path        from "path";
import { judge }   from "./judge";
import { scenarios } from "./scenarios";

const ROOT = path.resolve(__dirname, "../..");
const CLI  = path.join(ROOT, "dist/app/cli.js");

const args    = process.argv.slice(2);
const filter  = args.find(a => a.startsWith("--filter="))?.split("=")[1]
             ?? (args.includes("--filter") ? args[args.indexOf("--filter") + 1] : null);
const verbose = args.includes("--verbose");

// ── Public types (imported by scenarios.ts) ───────────────────────────────────

export interface Step {
  /** Message to send. Use {{DEC}}, {{ACT}}, {{REM}} to inject captured IDs. */
  input: string;
  /**
   * After this step, capture the first matching ID into the named slot.
   * e.g. captureAs: "DEC" captures the first DEC-NNNN from the response.
   */
  captureAs?: "DEC" | "ACT" | "REM";
  /** Plain-English assertion evaluated by the LLM judge. */
  assert?: string;
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

interface StepFailure {
  step: string;
  assertion: string;
  reason: string;
}

async function runScenario(
  scenario: Scenario,
): Promise<{ passed: boolean; stepOutputs: string[]; failures: StepFailure[] }> {
  const normalised: Step[] = scenario.steps.map(s =>
    typeof s === "string" ? { input: s } : s,
  );

  const captures: Record<string, string> = {};
  const stepOutputs: string[] = [];
  const failures: StepFailure[] = [];

  let pendingSharedInputs: string[] = [];
  let pendingSharedSteps: Step[] = [];

  const flushShared = async () => {
    if (pendingSharedInputs.length === 0) return;
    const outputs = await runMultiLine(pendingSharedInputs);
    for (let i = 0; i < pendingSharedSteps.length; i++) {
      const stepOut = outputs[i] ?? "";
      stepOutputs.push(stepOut);
      const step = pendingSharedSteps[i]!;
      if (step.captureAs) {
        const pat = ID_PATTERNS[step.captureAs];
        const match = pat?.exec(stepOut);
        if (match) captures[step.captureAs] = match[0];
      }
      if (step.assert) {
        const result = await judge(stepOut, step.assert);
        if (!result.pass) {
          failures.push({ step: step.input.slice(0, 60), assertion: step.assert, reason: result.reason });
        } else if (verbose) {
          process.stdout.write(`    [judge] PASS — ${result.reason}\n`);
        }
      }
    }
    pendingSharedInputs = [];
    pendingSharedSteps = [];
  };

  for (const step of normalised) {
    const resolvedInput = applyCaptures(step.input, captures);

    if (step.shareProcess) {
      pendingSharedInputs.push(resolvedInput);
      pendingSharedSteps.push(step);
      continue;
    }

    // Flush any pending shared steps before running a new isolated step
    await flushShared();

    const output = await runOneLine(resolvedInput);
    stepOutputs.push(output);

    // Capture a reference ID from this step's output if requested
    if (step.captureAs) {
      const pat = ID_PATTERNS[step.captureAs];
      const match = pat?.exec(output);
      if (match) captures[step.captureAs] = match[0];
    }

    // Per-step assertion
    if (step.assert) {
      const result = await judge(output, step.assert);
      if (!result.pass) {
        failures.push({
          step: resolvedInput.slice(0, 60),
          assertion: step.assert,
          reason: result.reason,
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
    const result = await judge(combined, scenario.assert);
    if (!result.pass) {
      failures.push({
        step: "(overall)",
        assertion: scenario.assert,
        reason: result.reason,
      });
    } else if (verbose) {
      process.stdout.write(`    [judge] PASS (overall) — ${result.reason}\n`);
    }
  }

  return { passed: failures.length === 0, stepOutputs, failures };
}

// ── CLI process spawner ───────────────────────────────────────────────────────

/**
 * Spawns a fresh CLI process, sends one line, collects stdout until the process
 * exits or the kill deadline is reached.
 *
 * Timeline:
 *   200ms  — write the input line
 *   2200ms — close stdin (signals EOF to the CLI readline loop)
 *   7000ms — force-kill if still running (scheduler timers keep Node alive)
 */
function runOneLine(input: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("node", [CLI], {
      cwd: ROOT,
      env: { ...process.env, LOG_LEVEL: "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });

    // Write the line then close stdin
    const writeTimer = setTimeout(() => {
      proc.stdin.write(input + "\n");
      setTimeout(() => proc.stdin.end(), 2000);
    }, 200);

    // Hard kill if process hasn't exited 4.5s after stdin closed
    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 7000);

    proc.on("close", () => {
      clearTimeout(writeTimer);
      clearTimeout(killTimer);
      resolve(stdout);
    });
  });
}

/**
 * Spawns one CLI process, sends multiple lines sequentially (1s apart), and
 * returns the stdout segments captured between each write. Used for follow-up
 * / context-dependent exchanges where conversation state must persist.
 */
function runMultiLine(inputs: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn("node", [CLI], {
      cwd: ROOT,
      env: { ...process.env, LOG_LEVEL: "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const segments: string[] = inputs.map(() => "");
    let currentIdx = 0;
    proc.stdout.on("data", (d: Buffer) => {
      if (currentIdx < segments.length) segments[currentIdx] += d.toString();
    });

    const killTimer = setTimeout(() => proc.kill("SIGKILL"), inputs.length * 4000 + 3000);

    // Send each line with a 2s gap so the bot can respond before the next arrives
    let delay = 300;
    for (let i = 0; i < inputs.length; i++) {
      const idx = i;
      setTimeout(() => {
        proc.stdin.write(inputs[idx]! + "\n");
        // After writing, wait 2s for the response then advance the segment pointer
        setTimeout(() => { currentIdx = idx + 1; }, 2000);
      }, delay);
      delay += 3000;
    }
    // Close stdin after all lines have been sent and responses collected
    setTimeout(() => proc.stdin.end(), delay);

    proc.on("close", () => {
      clearTimeout(killTimer);
      resolve(segments);
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const toRun = filter
    ? scenarios.filter(s => s.id.includes(filter) || s.description.toLowerCase().includes(filter.toLowerCase()))
    : scenarios;

  if (toRun.length === 0) {
    console.error(`No scenarios match filter: ${filter}`);
    process.exit(1);
  }

  console.log(`\nJeeves E2E — running ${toRun.length} scenario(s)\n${"─".repeat(70)}`);

  let passed = 0;
  let failed = 0;

  for (const scenario of toRun) {
    process.stdout.write(`  ${scenario.id.padEnd(16)} ${scenario.description.padEnd(50)} `);
    const result = await runScenario(scenario);

    if (result.passed) {
      console.log("✓ PASS");
      passed++;
    } else {
      console.log("✗ FAIL");
      failed++;
      for (const f of result.failures) {
        console.log(`    └ [${f.step}]`);
        console.log(`      assert: ${f.assertion}`);
        console.log(`      reason: ${f.reason}`);
      }
    }

    if (verbose || !result.passed) {
      const lines = result.stepOutputs.join("\n").trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        console.log(`    Output (${lines.length} line(s)):`);
        for (const line of lines) console.log(`      │ ${line}`);
      }
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
