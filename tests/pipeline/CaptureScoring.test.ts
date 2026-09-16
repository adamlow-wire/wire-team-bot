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
