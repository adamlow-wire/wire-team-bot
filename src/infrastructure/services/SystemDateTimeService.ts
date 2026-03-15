import * as chrono from "chrono-node";
import type { DateTimeService, ParsedDateTime } from "../../domain/services/DateTimeService";

export class SystemDateTimeService implements DateTimeService {
  parse(input: string, options: { timezone: string }): ParsedDateTime | null {
    const refDate = new Date();

    // chrono-node parses natural language like "in 1 hour", "tomorrow at 3pm", "next Friday"
    const results = chrono.parse(input, refDate, { forwardDate: true });
    if (results.length === 0) return null;

    const result = results[0];
    const date = result.date();
    if (!date || isNaN(date.getTime())) return null;

    // chrono works in the system timezone by default. If the user's conversation
    // timezone differs, adjust: re-parse with a reference date at midnight in that zone.
    // For "at 3pm" style inputs (time only, no date), shift to the target timezone.
    const hasExplicitDate = result.start.isCertain("day");
    const hasExplicitTime = result.start.isCertain("hour");

    if (hasExplicitTime && !hasExplicitDate && options.timezone !== "UTC") {
      // Time-only expression like "at 3pm" — interpret in the conversation timezone
      const tzDate = new Date(date.toLocaleString("en-US", { timeZone: options.timezone }));
      const offset = date.getTime() - tzDate.getTime();
      return { value: new Date(date.getTime() + offset), ambiguous: false };
    }

    return { value: date, ambiguous: false };
  }
}
