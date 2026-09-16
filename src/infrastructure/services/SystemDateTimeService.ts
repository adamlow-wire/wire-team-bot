import * as chrono from "chrono-node";
import type { DateTimeService, ParsedDateTime } from "../../domain/services/DateTimeService";

export class SystemDateTimeService implements DateTimeService {
  parse(input: string, options: { timezone: string }): ParsedDateTime | null {
    const refDate = new Date();

    if (/^(?:the )?end of (?:this |the )?month$/i.test(input.trim())) {
      try {
        const parts = new Intl.DateTimeFormat("en-GB", { timeZone: options.timezone,
          year: "numeric", month: "numeric" }).formatToParts(refDate);
        const year = Number(parts.find(p => p.type === "year")!.value);
        const month = Number(parts.find(p => p.type === "month")!.value);
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        // End of the calendar month in the conversation's zone, not the host zone.
        const wallTime = Date.UTC(year, month - 1, lastDay, 23, 59, 59);
        let instant = wallTime;
        const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: options.timezone,
          year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
          second: "numeric", hourCycle: "h23" });
        for (let i = 0; i < 3; i++) {
          const values = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
          const local = Date.UTC(Number(values.year), Number(values.month)-1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
          instant += wallTime - local;
        }
        return { value: new Date(instant), ambiguous: false };
      } catch { return null; }
    }

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
