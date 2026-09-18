import * as chrono from "chrono-node";
import type { DateTimeService, ParsedDateTime } from "../../domain/services/DateTimeService";

/** Offset at an instant, including the zone's daylight-saving rules. */
function offsetMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone,
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    second: "numeric", hourCycle: "h23" }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const wall = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second));
  return (wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000;
}

export class SystemDateTimeService implements DateTimeService {
  constructor(private readonly now: () => Date = () => new Date()) {}
  parse(input: string, options: { timezone: string }): ParsedDateTime | null {
    const refDate = this.now();

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

    try {
      const offset = offsetMinutes(refDate, options.timezone);
      const reference = { instant: refDate, timezone: offset };
      let result = chrono.parse(input, reference, { forwardDate: true })[0];
      if (!result) return null;

      // Noon is only an implied time. It must not turn today's date-only weekday
      // into next week's deadline once noon passes. Explicit "next Friday" and
      // past requests with an explicit time keep chrono's forward-date behaviour.
      if (result.start.isCertain("weekday")) {
        const calendar = chrono.parse(input, reference, { forwardDate: false })[0];
        const localReference = new Date(refDate.getTime() + offset * 60_000);
        if (calendar && calendar.start.get("year") === localReference.getUTCFullYear()
          && calendar.start.get("month") === localReference.getUTCMonth() + 1
          && calendar.start.get("day") === localReference.getUTCDate()
          && (!calendar.start.isCertain("hour") || calendar.date() >= refDate)) result = calendar;
      }

      let date = result.date();
      if (!date || isNaN(date.getTime())) return null;
      // Explicit zones and elapsed durations already identify an instant. Other
      // calendar expressions use the conversation zone's offset on the target
      // date, which can differ from today's offset across a DST transition.
      if (!result.start.isCertain("timezoneOffset")) {
        const wall = date.getTime() + offset * 60_000;
        for (let i = 0; i < 3; i++) date = new Date(wall - offsetMinutes(date, options.timezone) * 60_000);
      }
      return { value: date, ambiguous: false };
    } catch { return null; }
  }
}
