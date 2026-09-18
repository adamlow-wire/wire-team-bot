import { expect, it } from "vitest";
import { checkStoredRecords, type StoredRecord, type ExpectedRecord } from "../e2e/storedRecords";

const record: StoredRecord = { type: "action", source: "commitment", content: "Update API documentation",
  owner: "alice@cli.local", deadline: "2026-09-18T12:00:00.000Z", status: "open" };
const fact: ExpectedRecord = { type: "action", sourceStep: 1, terms: ["API", "documentation"],
  owner: "alice@cli.local", deadline: "2026-09-18T12:00:00.000Z", status: "open" };

it("matches a silent capture by source, fact, qualified owner and exact deadline", () => {
  expect(checkStoredRecords([record], [fact], ["commitment"])).toEqual([]);
});

it.each([
  { source: "another-event" }, { owner: "bob@cli.local" }, { owner: "alice@other.local" },
  { deadline: "2026-09-25T12:00:00.000Z" }, { content: "Update the sales report" }, { status: "done" },
])("rejects wrong stored facts even if a reply/judge looks correct: %j", change => {
  expect(checkStoredRecords([{ ...record, ...change }], [fact], ["commitment"])).not.toEqual([]);
});

it("counts duplicate and unexpected captures as failures", () => {
  expect(checkStoredRecords([record, record], [fact], ["commitment"])).toHaveLength(1);
  expect(checkStoredRecords([record], [], ["commitment"])).toHaveLength(1);
  expect(checkStoredRecords([], [fact], ["commitment"])).toHaveLength(1);
  expect(checkStoredRecords([], [], ["commitment"])).toEqual([]);
});

it("checks recorder identity separately from known decision makers", () => {
  const decision: StoredRecord = { type: "decision", source: "recorded", content: "Use Terraform",
    author: "alice@cli.local", decidedBy: [], status: "active" };
  const expected: ExpectedRecord = { type: "decision", sourceStep: 1, terms: ["Terraform"],
    author: "alice@cli.local", decidedBy: [] };
  expect(checkStoredRecords([decision], [expected], ["recorded"])).toEqual([]);
  expect(checkStoredRecords([{ ...decision, author: "bob@cli.local" }], [expected], ["recorded"])).not.toEqual([]);
  expect(checkStoredRecords([{ ...decision, decidedBy: ["Alice"] }], [expected], ["recorded"])).not.toEqual([]);
});
