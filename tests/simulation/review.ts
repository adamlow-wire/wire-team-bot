/**
 * Jeeves simulation review tool.
 *
 * Reads the report produced by `npm run simulate` and walks you through every
 * extracted decision, action and reminder so you can mark each one as:
 *
 *   y  — correct extraction
 *   n  — false positive (should NOT have been extracted)
 *   ?  — uncertain / borderline
 *
 * You can also record items that were missed (should have been extracted but
 * weren't).  At the end the annotated verdicts are saved to golden.json, which
 * future simulation runs use to compute precision and recall automatically.
 *
 * Usage:
 *   npm run simulate:review
 */

import * as readline from "readline";
import fs            from "fs";
import path          from "path";

const REPORT_PATH = path.join(__dirname, "simulation-report.json");
const GOLDEN_PATH = path.join(__dirname, "golden.json");

// ── Types (mirrors simulate.ts — kept local to avoid running that module) ─────

interface Exchange {
  day: number;
  time: string;
  sender: string;
  text: string;
  note?: string;
  isQuery: boolean;
  botResponse: string;
  extractedIds: { DEC: string[]; ACT: string[]; REM: string[] };
}

interface SimulationReport {
  runAt: string;
  conversationDays: number;
  totalMessages: number;
  exchanges: Exchange[];
  allDecisionIds: string[];
  allActionIds: string[];
  allReminderIds: string[];
}

// ── Golden file format ────────────────────────────────────────────────────────

type Verdict = "correct" | "false-positive" | "uncertain";

interface GoldenEntry {
  id: string;
  verdict: Verdict;
  /** One-line summary of what was extracted (from bot response or message). */
  summary: string;
  sourceDay: number;
  sourceTime: string;
  sourceSender: string;
  /** Reviewer note — why something is a false positive or uncertain. */
  reviewNote?: string;
}

interface MissedEntry {
  type: "decision" | "action" | "reminder";
  expectedSummary: string;
  sourceDay: number;
  sourceTime: string;
  sourceSender: string;
}

interface GoldenFile {
  approvedAt: string;
  decisions: GoldenEntry[];
  actions: GoldenEntry[];
  reminders: GoldenEntry[];
  missed: MissedEntry[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function printItem(id: string, ex: Exchange) {
  console.log(`  [${id}]`);
  console.log(`    Day ${ex.day}  ${ex.time}  — ${ex.sender}`);
  console.log(`    Message : "${truncate(ex.text, 70)}"`);
  const resp = ex.botResponse.trim().replace(/\n+/g, " ");
  if (resp) {
    console.log(`    Bot resp: "${truncate(resp, 70)}"`);
  }
  if (ex.note) {
    console.log(`    Fixture : ${ex.note}`);
  }
}

// ── Interactive review ────────────────────────────────────────────────────────

async function reviewSection(
  label: string,
  ids: string[],
  exchanges: Exchange[],
  rl: readline.Interface,
): Promise<GoldenEntry[]> {
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  const results: GoldenEntry[] = [];

  if (ids.length === 0) {
    console.log(`\n${label}: (none extracted — nothing to review)`);
    return results;
  }

  console.log(`\n${"─".repeat(62)}`);
  console.log(`${label}  (${ids.length} extracted)\n`);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const ex = exchanges.find(e => e.extractedIds[
      label.startsWith("DECISION") ? "DEC" :
      label.startsWith("ACTION")   ? "ACT" : "REM"
    ].includes(id));

    console.log(`  Item ${i + 1} of ${ids.length}:`);
    if (ex) {
      printItem(id, ex);
    } else {
      console.log(`  [${id}]  (source message not found in report)`);
    }

    let raw = "";
    while (!["y", "n", "?"].includes(raw)) {
      raw = (await ask("  Correct? [y]es / [n]o (false positive) / [?] uncertain: "))
        .trim().toLowerCase();
    }

    const verdict: Verdict =
      raw === "y" ? "correct" :
      raw === "n" ? "false-positive" :
                    "uncertain";

    let reviewNote: string | undefined;
    if (verdict !== "correct") {
      const note = (await ask("  Note (optional, press Enter to skip): ")).trim();
      if (note) reviewNote = note;
    }

    results.push({
      id,
      verdict,
      summary: ex
        ? truncate((ex.botResponse || ex.text).trim().replace(/\n/g, " "), 120)
        : id,
      sourceDay:    ex?.day    ?? 0,
      sourceTime:   ex?.time   ?? "",
      sourceSender: ex?.sender ?? "",
      reviewNote,
    });

    console.log("");
  }

  return results;
}

async function collectMissed(rl: readline.Interface): Promise<MissedEntry[]> {
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  const missed: MissedEntry[] = [];

  console.log(`\n${"─".repeat(62)}`);
  console.log("MISSED ITEMS\n");
  console.log("Record any decisions, actions or reminders that should have");
  console.log("been extracted but weren't.  Press Enter on an empty type to finish.\n");

  while (true) {
    const typeRaw = (await ask("  type — decision / action / reminder (or Enter to finish): "))
      .trim().toLowerCase();
    if (!typeRaw) break;

    if (!["decision", "action", "reminder"].includes(typeRaw)) {
      console.log("  Please enter 'decision', 'action', or 'reminder'.");
      continue;
    }

    const expectedSummary = (await ask("  What should have been extracted? ")).trim();
    const dayRaw          = (await ask("  Source day (1/2/3):  ")).trim();
    const sourceTime      = (await ask("  Source time (HH:MM): ")).trim();
    const sourceSender    = (await ask("  Source sender:        ")).trim();

    missed.push({
      type:            typeRaw as "decision" | "action" | "reminder",
      expectedSummary,
      sourceDay:       parseInt(dayRaw, 10) || 0,
      sourceTime,
      sourceSender,
    });
    console.log("  Recorded.\n");
  }

  return missed;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(REPORT_PATH)) {
    console.error("\nNo simulation report found.");
    console.error("Run the simulation first:  npm run simulate\n");
    process.exit(1);
  }

  const report: SimulationReport = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));

  const totalExtracted =
    report.allDecisionIds.length +
    report.allActionIds.length +
    report.allReminderIds.length;

  console.log("\n" + "═".repeat(62));
  console.log("  JEEVES SIMULATION REVIEW");
  console.log("═".repeat(62));
  console.log(`  Report from : ${report.runAt}`);
  console.log(`  Conversation: ${report.conversationDays} days, ${report.totalMessages} messages`);
  console.log(`  Extracted   : ${report.allDecisionIds.length} decisions, ` +
    `${report.allActionIds.length} actions, ${report.allReminderIds.length} reminders ` +
    `(${totalExtracted} total)`);

  if (totalExtracted === 0) {
    console.log("\n  Nothing was extracted — check the simulation ran successfully.\n");
    process.exit(0);
  }

  console.log("\n  Mark each item as:");
  console.log("    y = correct extraction");
  console.log("    n = false positive (should NOT have been extracted)");
  console.log("    ? = uncertain / borderline");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const decisions = await reviewSection(
      "DECISIONS", report.allDecisionIds, report.exchanges, rl,
    );
    const actions = await reviewSection(
      "ACTIONS", report.allActionIds, report.exchanges, rl,
    );
    const reminders = await reviewSection(
      "REMINDERS", report.allReminderIds, report.exchanges, rl,
    );
    const missed = await collectMissed(rl);

    rl.close();

    const golden: GoldenFile = {
      approvedAt: new Date().toISOString(),
      decisions,
      actions,
      reminders,
      missed,
    };

    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2));

    // Summary
    const allEntries = [...decisions, ...actions, ...reminders];
    const correct    = allEntries.filter(e => e.verdict === "correct").length;
    const fp         = allEntries.filter(e => e.verdict === "false-positive").length;
    const uncertain  = allEntries.filter(e => e.verdict === "uncertain").length;

    console.log("\n" + "═".repeat(62));
    console.log("  REVIEW COMPLETE");
    console.log("═".repeat(62));
    console.log(`  Correct         : ${correct}`);
    console.log(`  False positives : ${fp}`);
    console.log(`  Uncertain       : ${uncertain}`);
    console.log(`  Missed          : ${missed.length}`);
    if (totalExtracted > 0) {
      const precision = correct / totalExtracted;
      console.log(`  Precision       : ${Math.round(precision * 100)}%`);
    }
    console.log(`\n  Golden saved → ${path.relative(path.resolve(__dirname, "../.."), GOLDEN_PATH)}`);
    console.log("  Future runs will show precision/recall vs this baseline.\n");

  } catch (err) {
    rl.close();
    throw err;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
