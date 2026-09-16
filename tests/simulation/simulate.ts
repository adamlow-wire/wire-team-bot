/** Replay the multi-day fixture; inventory committed records after each event drains. */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION } from "./conversation";

const directory = mkdtempSync(join(tmpdir(), "wire-team-bot-simulation-"));
const fixture = join(directory, "fixture.json");
writeFileSync(fixture, JSON.stringify({
  reviewStatus: "Stored-record inventory only; human fact matching and missed-event review required",
  events: CONVERSATION.map((message, index) => ({ ...message, eventId: `simulation-${index + 1}`, text: `${message.sender}: ${message.text}` })),
  questions: [],
}));
try {
  const result = spawnSync("node", ["tests/acceptance/evaluate.mjs"], {
    stdio: "inherit",
    env: { ...process.env, EVALUATION_FIXTURE: fixture, EVALUATION_REPORT: "tests/simulation/simulation-report.json" },
  });
  process.exitCode = result.status ?? 1;
} finally { rmSync(directory, { recursive: true }); }
