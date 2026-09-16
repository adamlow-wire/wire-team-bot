/** Human review uses source events and facts, never generated record IDs. */
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";

async function main(): Promise<void> {
  const report = JSON.parse(readFileSync("tests/simulation/simulation-report.json", "utf8")) as {
    runAt: string; channel: string;
    overall: { records: Array<{ type: string; source: string; content: string; owner?: string }> };
    exchanges: Array<{ eventId: string; text: string }>;
  };
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reviewer = await reader.question("Reviewer name: ");
    if (!reviewer.trim()) throw new Error("A reviewer is required");
    const records = [];
    for (const record of report.overall.records) {
      console.log(`\nSource ${record.source}: ${report.exchanges.find(e => e.eventId === record.source)?.text ?? "unknown"}`);
      console.log(`${record.type}: ${record.content} (owner: ${record.owner ?? "n/a"})`);
      let verdict = "";
      while (!["correct", "false-positive", "duplicate", "uncertain"].includes(verdict)) {
        verdict = await reader.question("Verdict (correct / false-positive / duplicate / uncertain): ");
      }
      records.push({ ...record, verdict, note: await reader.question("Fact/correction note: ") });
    }
    console.log("\nReview every source event for missed captures:");
    for (const event of report.exchanges) console.log(`${event.eventId}: ${event.text}`);
    const missed = [];
    for (;;) {
      const source = await reader.question("Missed source event ID (empty when finished): ");
      if (!source) break;
      if (!report.exchanges.some(e => e.eventId === source)) { console.log("Unknown source event"); continue; }
      missed.push({ source, fact: await reader.question("Expected fact and owner: ") });
    }
    writeFileSync("tests/simulation/golden.json", JSON.stringify({ reviewer, reviewedAt: new Date().toISOString(), runAt: report.runAt, channel: report.channel, records, missed }, null, 2) + "\n");
  } finally { reader.close(); }
}
void main().catch(err => { console.error(err); process.exitCode = 1; });
