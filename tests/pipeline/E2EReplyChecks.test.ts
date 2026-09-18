import { expect, it } from "vitest";
import { exactReplyMatches } from "../e2e/replyChecks";

const confirmation = "Action **ACT-0001** created for **@Bob**: prepare the deck (due this Friday: 18 Sept 2026, 12:00)";
it("accepts the full deterministic confirmation including the same-Friday date", () => {
  expect(exactReplyMatches(confirmation + "\n", confirmation)).toBe(true);
});
it.each([
  confirmation.replace("18 Sept", "25 Sept"),
  confirmation.replace("@Bob", "@Alice"),
  confirmation + "\nAlso created an action for Alice.",
  "That is the right syntax; please send it again.",
])("rejects wrong dates, owners, extra output and fabricated acknowledgements", output => {
  expect(exactReplyMatches(output, confirmation)).toBe(false);
});
