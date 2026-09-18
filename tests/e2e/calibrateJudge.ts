/** Check the evaluator itself against reviewed correct and deliberately wrong answers. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judge, type EvaluationContext } from "./judge";

interface Case {
  id: string;
  reply: string;
  assertion: string;
  expectedPass: boolean;
  context: EvaluationContext;
}

async function main() {
  const cases: Case[] = JSON.parse(readFileSync(join(__dirname, "../acceptance/judge-calibration-fixture.json"), "utf8"));
  const results = [];
  for (let i = 0; i < cases.length; i += 3) {
    results.push(...await Promise.all(cases.slice(i, i + 3).map(async sample => {
      const result = await judge(sample.reply, sample.assertion, sample.context);
      const validVerdict = result.valid;
      return { ...sample, result, validVerdict, correct: validVerdict && result.pass === sample.expectedPass };
    })));
  }
  const report = { model: process.env.JEEVES_JUDGE_MODEL ?? process.env.JEEVES_MODEL_CLASSIFY,
    passed: results.filter(r => r.correct).length, total: results.length, results };
  const output = process.env.JUDGE_CALIBRATION_REPORT;
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  process.exitCode = report.passed === report.total ? 0 : 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
