/**
 * Simulation conversation fixture for Jeeves.
 *
 * A realistic 3-day engineering team channel transcript covering sprint
 * kickoff, implementation work, and a release day. It contains a mix of:
 *   - Explicit decisions / actions / reminders  → SHOULD be extracted
 *   - Natural pipeline-extracted statements      → SHOULD be extracted
 *   - Status updates, hypotheticals, chat, banter → should NOT be extracted
 *
 * `note` fields annotate what each message is expected to produce and are
 * printed in the human review report but never sent to the bot.
 *
 * Run the simulation:   npm run simulate
 * Review the output:    npm run simulate:review
 */

export interface SimMessage {
  day: number;     // relative day in the replay (1 = first day)
  time: string;    // wall-clock label, e.g. "09:15" — informational only
  sender: string;  // display name of the team member
  text: string;    // message text sent to the CLI
  /** Human-readable annotation — not sent to the bot. */
  note?: string;
  /** When true this message is a final state-check query, not conversation. */
  isQuery?: boolean;
}

// ---------------------------------------------------------------------------
// Ground-truth annotations (used in the review report as guidance)
//
//   EXPECT DECISION  — pipeline or explicit command should produce a DEC-ID
//   EXPECT ACTION    — pipeline or explicit command should produce an ACT-ID
//   EXPECT REMINDER  — explicit reminder command should produce a REM-ID
//   NO EXTRACTION    — message should pass through without logging anything
// ---------------------------------------------------------------------------

export const CONVERSATION: SimMessage[] = [

  // ── Day 1 — Sprint kickoff ────────────────────────────────────────────────

  {
    day: 1, time: "09:00", sender: "Alice",
    text: "morning all, kicking off sprint 12 today — main topics: database choice, API design, TypeScript config",
  },
  {
    day: 1, time: "09:02", sender: "Bob",
    text: "good morning! I did some reading on the database options last night",
  },
  {
    day: 1, time: "09:05", sender: "Carol",
    text: "same — I looked at PostgreSQL, MySQL and Aurora",
  },
  {
    day: 1, time: "09:08", sender: "Dave",
    text: "PostgreSQL seems like the obvious choice — our team already knows it and the JSONB support is excellent",
  },
  {
    day: 1, time: "09:12", sender: "Bob",
    text: "strong +1 from me on PostgreSQL",
  },
  {
    day: 1, time: "09:15", sender: "Alice",
    text: "decision: we're going with PostgreSQL as our primary database",
    note: "EXPECT DECISION: PostgreSQL as primary database (decided by Alice)",
  },
  {
    day: 1, time: "09:17", sender: "Carol",
    text: "Alice, can you set up the PostgreSQL instance on staging by Wednesday?",
    note: "EXPECT ACTION: Alice / set up PostgreSQL on staging / deadline Wednesday",
  },
  {
    day: 1, time: "09:19", sender: "Alice",
    text: "yep, I'll get that done by Wednesday",
  },
  {
    day: 1, time: "09:25", sender: "Bob",
    text: "I'll write the database migration scripts this week",
    note: "EXPECT ACTION: Bob / write migration scripts (self-assigned, this week)",
  },
  {
    day: 1, time: "09:30", sender: "Dave",
    text: "on TypeScript — I've been bitten by loose types one too many times, we should enforce strict mode",
  },
  {
    day: 1, time: "09:33", sender: "Alice",
    text: "decision: TypeScript strict mode across the whole codebase",
    note: "EXPECT DECISION: TypeScript strict mode across the codebase",
  },
  {
    day: 1, time: "09:35", sender: "Carol",
    text: "good call, will save a lot of debugging time",
  },
  {
    day: 1, time: "09:40", sender: "Bob",
    text: "what's the plan for API versioning — headers or URL paths?",
  },
  {
    day: 1, time: "09:42", sender: "Dave",
    text: "I prefer URL paths, they're more visible in logs and easier to test",
  },
  {
    day: 1, time: "09:45", sender: "Carol",
    text: "same here, simpler to route in nginx too",
  },
  {
    day: 1, time: "09:50", sender: "Alice",
    text: "ok: decision: URL path versioning for the API, /v1/, /v2/ etc",
    note: "EXPECT DECISION: URL path versioning (/v1/, /v2/)",
  },

  // ── Day 1 — Afternoon ────────────────────────────────────────────────────

  {
    day: 1, time: "14:00", sender: "Bob",
    text: "quick update — Flyway looks like a solid choice for the database migrations",
    note: "NO EXTRACTION: status update / tooling observation, not a decision",
  },
  {
    day: 1, time: "14:05", sender: "Dave",
    text: "we used Flyway at my last place, it works really well",
  },
  {
    day: 1, time: "14:10", sender: "Carol",
    text: "anyone heading for coffee? going now",
  },
  {
    day: 1, time: "14:12", sender: "Bob",
    text: "wish I could, knee-deep in this migration script",
  },
  {
    day: 1, time: "14:20", sender: "Alice",
    text: "Carol, can you review the auth service PR by end of day today?",
    note: "EXPECT ACTION: Carol / review auth service PR / deadline EOD today",
  },
  {
    day: 1, time: "14:22", sender: "Carol",
    text: "sure, I'll take a look before 5pm",
  },

  // ── Day 2 — Morning ───────────────────────────────────────────────────────

  {
    day: 2, time: "09:05", sender: "Bob",
    text: "morning! migration scripts are about 80% done",
    note: "NO EXTRACTION: progress update",
  },
  {
    day: 2, time: "09:08", sender: "Alice",
    text: "great progress Bob",
  },
  {
    day: 2, time: "09:15", sender: "Dave",
    text: "the API docs are really stale — they don't cover the new endpoints at all",
  },
  {
    day: 2, time: "09:18", sender: "Alice",
    text: "action: Dave to update the API documentation by end of next week",
    note: "EXPECT ACTION: Dave / update API documentation / deadline end of next week",
  },
  {
    day: 2, time: "09:20", sender: "Dave",
    text: "noted, I'll get it done",
  },
  {
    day: 2, time: "09:25", sender: "Carol",
    text: "remind Dave about the security audit on Thursday",
    note: "EXPECT REMINDER: Dave / security audit / Thursday",
  },
  {
    day: 2, time: "09:30", sender: "Bob",
    text: "it would be nice to eventually add Redis for the session cache… just thinking out loud",
    note: "NO EXTRACTION: vague hypothetical with no owner or commitment",
  },
  {
    day: 2, time: "09:35", sender: "Dave",
    text: "could be worth it further down the road, but nothing decided yet",
    note: "NO EXTRACTION: explicitly unconfirmed",
  },
  {
    day: 2, time: "09:40", sender: "Alice",
    text: "let's keep it in mind but no decision needed right now",
    note: "NO EXTRACTION: deferral statement",
  },

  // ── Day 2 — Afternoon ────────────────────────────────────────────────────

  {
    day: 2, time: "14:00", sender: "Carol",
    text: "auth PR reviewed — left a few minor comments",
    note: "NO EXTRACTION: status update on a completed task",
  },
  {
    day: 2, time: "14:05", sender: "Bob",
    text: "thanks Carol, I'll look at the comments now",
  },
  {
    day: 2, time: "14:20", sender: "Dave",
    text: "deployed the hotfix to staging this afternoon, all clear",
    note: "NO EXTRACTION: deployment status update, not a decision or action",
  },
  {
    day: 2, time: "14:25", sender: "Alice",
    text: "nice one Dave",
  },
  {
    day: 2, time: "14:30", sender: "Carol",
    text: "anyone joining the all-hands at 3?",
  },
  {
    day: 2, time: "14:32", sender: "Bob",
    text: "yes, just finishing up a few things",
  },

  // ── Day 3 — Release day ───────────────────────────────────────────────────

  {
    day: 3, time: "09:00", sender: "Alice",
    text: "release day — let's make sure everything is in order",
  },
  {
    day: 3, time: "09:05", sender: "Carol",
    text: "checklist looks good from my side",
    note: "NO EXTRACTION: status update",
  },
  {
    day: 3, time: "09:10", sender: "Bob",
    text: "we need to settle the deployment strategy — blue/green or rolling update?",
  },
  {
    day: 3, time: "09:13", sender: "Dave",
    text: "blue/green gives instant rollback capability, that's the safer option",
  },
  {
    day: 3, time: "09:15", sender: "Carol",
    text: "agreed, blue/green is the right call",
  },
  {
    day: 3, time: "09:18", sender: "Alice",
    text: "decision: blue/green deployment strategy for all production releases going forward",
    note: "EXPECT DECISION: blue/green deployment strategy",
  },
  {
    day: 3, time: "09:22", sender: "Carol",
    text: "Alice, can you create the release checklist document?",
    note: "EXPECT ACTION: Alice / create release checklist document",
  },
  {
    day: 3, time: "09:24", sender: "Alice",
    text: "on it",
  },
  {
    day: 3, time: "09:28", sender: "Bob",
    text: "I'll run the smoke tests before we push to prod",
    note: "EXPECT ACTION: Bob / run smoke tests before production push",
  },
  {
    day: 3, time: "09:32", sender: "Dave",
    text: "Carol, once we're live can you send the release announcement to the broader team?",
    note: "EXPECT ACTION: Carol / send release announcement once live",
  },
  {
    day: 3, time: "09:34", sender: "Carol",
    text: "will do",
  },
  {
    day: 3, time: "09:40", sender: "Alice",
    text: "remind me on Friday at 3pm to run the sprint retrospective",
    note: "EXPECT REMINDER: Alice / sprint retrospective / Friday 3pm",
  },
  {
    day: 3, time: "09:45", sender: "Bob",
    text: "quick question — are we keeping two-week sprints for next quarter?",
  },
  {
    day: 3, time: "09:47", sender: "Dave",
    text: "two weeks has been working really well for us",
  },
  {
    day: 3, time: "09:50", sender: "Alice",
    text: "decision: keeping two-week sprints going forward",
    note: "EXPECT DECISION: two-week sprints going forward",
  },
  {
    day: 3, time: "09:55", sender: "Carol",
    text: "it would also be nice if someone updated the team wiki at some point, no rush though",
    note: "NO EXTRACTION: vague ownerless suggestion, no commitment",
  },
  {
    day: 3, time: "10:00", sender: "Bob",
    text: "agreed, though nobody's claimed that task",
    note: "NO EXTRACTION: acknowledgement of a vague suggestion",
  },

  // ── Final state queries ───────────────────────────────────────────────────
  // These are sent last to capture the bot's full accumulated view.

  {
    day: 3, time: "10:10", sender: "Alice",
    text: "@jeeves list decisions",
    isQuery: true,
    note: "FINAL QUERY: full list of recorded decisions",
  },
  {
    day: 3, time: "10:11", sender: "Alice",
    text: "@jeeves team actions",
    isQuery: true,
    note: "FINAL QUERY: all open team actions",
  },
  {
    day: 3, time: "10:12", sender: "Alice",
    text: "@jeeves what reminders do I have?",
    isQuery: true,
    note: "FINAL QUERY: scheduled reminders",
  },
];
