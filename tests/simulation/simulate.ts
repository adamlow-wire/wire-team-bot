/**
 * Jeeves simulation runner.
 *
 * Replays the full multi-day conversation fixture through a single CLI
 * process, collects every bot response, parses out DEC/ACT/REM IDs, and
 * writes a machine-readable report plus a human-friendly console summary.
 *
 * If a golden baseline already exists it shows precision/recall vs that file.
 *
 * Usage:
 *   npm run simulate             — run simulation, print report
 *   npm run simulate:review      — interactively annotate the report as golden
 */

import { spawn }  from "child_process";
import path       from "path";
import fs         from "fs";
import { CONVERSATION, type SimMessage } from "./conversation";

const ROOT   = path.resolve(__dirname, "../..");
const CLI    = path.join(ROOT, "dist/app/cli.js");
const OUT    = path.join(__dirname, "simulation-report.json");
const GOLDEN = path.join(__dirname, "golden.json");

const ID_PATTERNS = {
  DEC: /DEC-\d+/gi,
  ACT: /ACT-\d+/gi,
  REM: /REM-\d+/gi,
} as const;

function scanIds(text: string, type: keyof typeof ID_PATTERNS): string[] {
  return [...text.matchAll(ID_PATTERNS[type])].map(m => m[0].toUpperCase());
}

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Exchange {
  day: number;
  time: string;
  sender: string;
  text: string;
  note?: string;
  isQuery: boolean;
  botResponse: string;
  extractedIds: { DEC: string[]; ACT: string[]; REM: string[] };
}

export interface SimulationReport {
  runAt: string;
  durationMs: number;
  conversationDays: number;
  totalMessages: number;
  exchanges: Exchange[];
  allDecisionIds: string[];
  allActionIds: string[];
  allReminderIds: string[];
}

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Feeds every message into a single CLI process with a 3.2 s gap between
 * writes (matching the timing used by the multi-line e2e runner) and returns
 * one response segment per message.
 *
 * onProgress is called each time a message is written so the caller can
 * display a progress indicator.
 */
function replayConversation(
  messages: string[],
  onProgress: (sent: number, total: number) => void,
): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn("node", [CLI], {
      cwd: ROOT,
      env: { ...process.env, LOG_LEVEL: "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const segments: string[] = messages.map(() => "");
    let currentIdx = 0;

    proc.stdout.on("data", (chunk: Buffer) => {
      if (currentIdx < segments.length) {
        segments[currentIdx] += chunk.toString();
      }
    });

    // Kill the process if it hasn't exited well past the expected finish time
    const killTimer = setTimeout(
      () => proc.kill("SIGKILL"),
      messages.length * 4000 + 8000,
    );

    // Write each message 3.2 s apart; advance the segment pointer 2.5 s after
    // each write so responses don't bleed into the next segment.
    let delay = 300;
    for (let i = 0; i < messages.length; i++) {
      const idx = i;
      setTimeout(() => {
        proc.stdin.write(messages[idx]! + "\n");
        onProgress(idx + 1, messages.length);
        setTimeout(() => { currentIdx = idx + 1; }, 2500);
      }, delay);
      delay += 3200;
    }
    // Close stdin after all responses have had time to arrive
    setTimeout(() => proc.stdin.end(), delay + 500);

    proc.on("close", () => {
      clearTimeout(killTimer);
      resolve(segments);
    });
  });
}

// ── Report printing ───────────────────────────────────────────────────────────

function printSummary(report: SimulationReport) {
  const SEP  = "─".repeat(62);
  const HEAD = "═".repeat(62);

  console.log(HEAD);
  console.log("  SIMULATION RESULTS");
  console.log(HEAD);
  console.log(
    `  ${report.conversationDays} days · ` +
    `${report.totalMessages} conversation messages · ` +
    `completed in ${Math.round(report.durationMs / 1000)}s`,
  );
  console.log("");

  const printSection = (
    label: string,
    ids: string[],
    getExchange: (id: string) => Exchange | undefined,
  ) => {
    console.log(`${label}  (${ids.length})`);
    console.log(SEP);
    if (ids.length === 0) {
      console.log("  (none)");
    } else {
      for (const id of ids) {
        const ex = getExchange(id);
        if (!ex) continue;
        console.log(`  [${id}]  Day ${ex.day}  ${ex.time}  — ${ex.sender}`);
        console.log(`          msg: "${truncate(ex.text, 65)}"`);
        const resp = ex.botResponse.trim().replace(/\n+/g, " ");
        if (resp) console.log(`          bot: "${truncate(resp, 65)}"`);
      }
    }
    console.log("");
  };

  printSection(
    "DECISIONS EXTRACTED",
    report.allDecisionIds,
    id => report.exchanges.find(e => e.extractedIds.DEC.includes(id)),
  );

  printSection(
    "ACTIONS EXTRACTED",
    report.allActionIds,
    id => report.exchanges.find(e => e.extractedIds.ACT.includes(id)),
  );

  printSection(
    "REMINDERS SET",
    report.allReminderIds,
    id => report.exchanges.find(e => e.extractedIds.REM.includes(id)),
  );

  // Final query responses
  const queries = report.exchanges.filter(e => e.isQuery && e.botResponse.trim());
  if (queries.length > 0) {
    console.log("FINAL STATE QUERIES");
    console.log(SEP);
    for (const q of queries) {
      console.log(`  > ${q.text}`);
      for (const line of q.botResponse.trim().split("\n")) {
        console.log(`    ${line}`);
      }
      console.log("");
    }
  }
}

// ── Golden comparison ─────────────────────────────────────────────────────────

interface GoldenEntry {
  id: string;
  verdict: "correct" | "false-positive" | "uncertain";
}

interface GoldenFile {
  approvedAt?: string;
  decisions?: GoldenEntry[];
  actions?: GoldenEntry[];
  reminders?: GoldenEntry[];
  missed?: Array<{ type: string }>;
}

function printGoldenComparison(report: SimulationReport, golden: GoldenFile) {
  const decisions = Array.isArray(golden.decisions) ? golden.decisions : [];
  const actions   = Array.isArray(golden.actions) ? golden.actions : [];
  const reminders = Array.isArray(golden.reminders) ? golden.reminders : [];
  const missed    = Array.isArray(golden.missed) ? golden.missed : [];

  const hasAnyBaseline =
    decisions.length > 0 ||
    actions.length > 0 ||
    reminders.length > 0 ||
    missed.length > 0;

  if (!hasAnyBaseline) {
    console.log("No annotated golden baseline found.");
    console.log("Annotate the latest run with:  npm run simulate:review\n");
    return;
  }

  const HEAD = "═".repeat(62);
  const SEP  = "─".repeat(62);

  console.log(HEAD);
  console.log("  COMPARISON VS GOLDEN BASELINE");
  console.log(`  (approved: ${golden.approvedAt ?? "unapproved"})`);
  console.log(HEAD);
  console.log("");

  const score = (
    extracted: string[],
    goldenEntries: GoldenEntry[],
    missedCount: number,
  ) => {
    const correct  = extracted.filter(id =>
      goldenEntries.find(e => e.id === id && e.verdict === "correct"),
    ).length;
    const fp       = extracted.filter(id =>
      goldenEntries.find(e => e.id === id && e.verdict === "false-positive"),
    ).length;
    const newItems = extracted.filter(id => !goldenEntries.find(e => e.id === id)).length;
    const precision = extracted.length > 0 ? correct / extracted.length : 1;
    const recall    = (correct + missedCount) > 0
      ? correct / (correct + missedCount)
      : 1;
    return { correct, fp, newItems, precision, recall };
  };

  const decMissed = missed.filter(m => m.type === "decision").length;
  const actMissed = missed.filter(m => m.type === "action").length;

  const dec = score(report.allDecisionIds, decisions, decMissed);
  const act = score(report.allActionIds,   actions,   actMissed);
  const rem = score(report.allReminderIds, reminders, 0);

  const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(5);

  console.log("                  Precision   Recall    Correct  FP  New");
  console.log(SEP);
  console.log(`  Decisions       ${pct(dec.precision)}      ${pct(dec.recall)}      ${String(dec.correct).padStart(5)}   ${String(dec.fp).padStart(2)}   ${dec.newItems}`);
  console.log(`  Actions         ${pct(act.precision)}      ${pct(act.recall)}      ${String(act.correct).padStart(5)}   ${String(act.fp).padStart(2)}   ${act.newItems}`);
  console.log(`  Reminders       ${pct(rem.precision)}      n/a         ${String(rem.correct).padStart(5)}   ${String(rem.fp).padStart(2)}   ${rem.newItems}`);
  console.log("");

  const allNew = [
    ...report.allDecisionIds.filter(id => !decisions.find(e => e.id === id)),
    ...report.allActionIds.filter(id => !actions.find(e => e.id === id)),
    ...report.allReminderIds.filter(id => !reminders.find(e => e.id === id)),
  ];
  if (allNew.length > 0) {
    console.log(`  IDs not yet in golden: ${allNew.join(", ")}`);
    console.log("  Run: npm run simulate:review  to update the baseline");
    console.log("");
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CLI)) {
    console.error(`\nCLI not found: ${CLI}`);
    console.error("Build first with:  npm run build\n");
    process.exit(1);
  }

  const messages = CONVERSATION;
  const total    = messages.length;
  const convCount  = messages.filter(m => !m.isQuery).length;
  const queryCount = messages.filter(m =>  m.isQuery).length;
  const estSecs  = Math.ceil(total * 3.2 + 5);

  console.log("\nJeeves Simulation");
  console.log("─".repeat(62));
  console.log(`  Messages : ${convCount} conversation + ${queryCount} final queries`);
  console.log(`  Days     : ${Math.max(...messages.map(m => m.day))}`);
  console.log(`  Est. time: ~${Math.ceil(estSecs / 60)}m ${estSecs % 60}s`);
  console.log("");

  const startMs = Date.now();

  const segments = await replayConversation(
    messages.map(m => m.text),
    (sent, tot) => {
      process.stdout.write(`\r  Progress: ${sent}/${tot} messages sent...`);
    },
  );

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  process.stdout.write(`\r  Progress: ${total}/${total} messages — done in ${elapsed}s\n\n`);

  const exchanges: Exchange[] = messages.map((msg, i) => ({
    day:     msg.day,
    time:    msg.time,
    sender:  msg.sender,
    text:    msg.text,
    note:    msg.note,
    isQuery: msg.isQuery ?? false,
    botResponse:  segments[i]?.trim() ?? "",
    extractedIds: {
      DEC: scanIds(segments[i] ?? "", "DEC"),
      ACT: scanIds(segments[i] ?? "", "ACT"),
      REM: scanIds(segments[i] ?? "", "REM"),
    },
  }));

  const report: SimulationReport = {
    runAt:            new Date().toISOString(),
    durationMs:       Date.now() - startMs,
    conversationDays: Math.max(...messages.map(m => m.day)),
    totalMessages:    convCount,
    exchanges,
    allDecisionIds: dedup(exchanges.flatMap(e => e.extractedIds.DEC)).sort(),
    allActionIds:   dedup(exchanges.flatMap(e => e.extractedIds.ACT)).sort(),
    allReminderIds: dedup(exchanges.flatMap(e => e.extractedIds.REM)).sort(),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`  Report written → ${path.relative(ROOT, OUT)}\n`);

  printSummary(report);

  if (fs.existsSync(GOLDEN)) {
    printGoldenComparison(report, JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
  } else {
    console.log("No golden baseline found.");
    console.log("Annotate this run with:  npm run simulate:review\n");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
