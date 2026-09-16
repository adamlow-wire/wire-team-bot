import { it, expect } from "vitest";
import { score } from "../acceptance/scoring.mjs";
it("counts silent records, duplicate window captures and wrong-owner misses without using generated IDs", () => {
  const expected=[{eventId:"m1",expected:{type:"action",terms:["deploy"],owner:"bob"}},{eventId:"m2",expected:{type:"decision",terms:["Postgres"]}}];
  const records=[{type:"action",source:"m1",content:"Deploy service",owner:"bob"},{type:"action",source:"other",content:"Deploy service",owner:"bob"},{type:"decision",source:"m2",content:"Use Postgres"}];
  const result=score(records,expected);
  expect(result.correct).toBe(2);
  expect(result.captured).toBe(3);
  expect(result.duplicates).toBe(1);
  expect(result.precision).toBe(2/3);
  expect(result.recall).toBe(1);
  expect(score([{...records[0],owner:"alice"}],expected).correct).toBe(0);
});

it("counts duplicate facts independently of database row order", () => {
  const expected = [{ eventId: "original", expected: { type: "action", terms: ["deploy"], owner: "bob" } }];
  const correct = { type: "action", source: "original", content: "Deploy service", owner: "bob" };
  const replay = { ...correct, source: "replay" };
  for (const records of [[replay, correct], [correct, replay]]) {
    expect(score(records, expected)).toMatchObject({ correct: 1, captured: 2, duplicates: 1, precision: 0.5, recall: 1 });
  }
  expect(score([replay, { ...replay, source: "another-replay" }], expected))
    .toMatchObject({ correct: 0, duplicates: 1, precision: 0, recall: 0 });
});

it("matches the source before choosing between identical expected facts", () => {
  const expected = ["first", "second"].map(eventId => ({ eventId, expected: { type: "decision", terms: ["Postgres"] } }));
  const records = ["second", "first"].map(source => ({ type: "decision", source, content: "Use Postgres" }));
  expect(score(records, expected)).toMatchObject({ correct: 2, captured: 2, duplicates: 0, precision: 1, recall: 1, missed: [] });
});
