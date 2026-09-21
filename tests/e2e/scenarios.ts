/**
 * E2E scenarios for Jeeves.
 *
 * Inputs are natural language — the way team members actually talk.
 * Assertions are plain English describing what a correct response looks like.
 * The LLM judge evaluates answers; selected scenarios also require exact stored facts.
 *
 * Steps that are plain strings send a message with no assertion (context only).
 * Steps with `assert` are evaluated. Steps with `captureAs` extract a reference
 * ID for use in later steps via {{DEC}}, {{ACT}}, or {{REM}}.
 *
 * Run: npm run test:e2e
 */

import type { Scenario } from "./runner";

export const scenarios: Scenario[] = [

  // ── Feature 1: Decision Management ──────────────────────────────────────

  {
    id: "TC-DEC-01",
    description: "Log a decision — gets a DEC reference back",
    steps: [
      {
        input: "decision: we will use PostgreSQL as our primary database",
        captureAs: "DEC",
        assert: "Jeeves confirms the decision was recorded and includes a DEC- reference number",
      },
    ],
  },

  {
    id: "TC-DEC-02",
    description: "Log then retrieve by topic",
    steps: [
      {
        input: "decision: the team will move to two-week sprints",
        captureAs: "DEC",
      },
      {
        input: "@jeeves what have we decided about our sprint length?",
        assert: "Jeeves describes a decision about two-week or fortnightly sprints",
      },
    ],
  },

  {
    id: "TC-DEC-03",
    description: "List decisions — includes the previously logged decision",
    steps: [
      {
        input: "decision: we will standardise on kebab-case for all URL slugs",
        captureAs: "DEC",
      },
      {
        input: "list decisions",
        assert: "Jeeves lists decisions and includes {{DEC}}",
      },
    ],
  },

  {
    id: "TC-DEC-04",
    description: "Supersede using a lowercase decision ID — old marked, new logged",
    stored: [
      { type: "decision", sourceStep: 1, terms: ["deploy", "Fridays"], status: "superseded", author: "alice@cli.local" },
      { type: "decision", sourceStep: 2, terms: ["never deploy", "Fridays"], status: "active", author: "alice@cli.local" },
    ],
    steps: [
      {
        input: "decision: we will deploy on Fridays",
        captureAs: "DEC",
      },
      {
        input: "decision: we will never deploy on Fridays supersedes {{dec}}",
        assert: "Jeeves confirms that the previous decision has been superseded and records the new one with a DEC- reference",
      },
    ],
  },

  {
    id: "TC-DEC-05",
    description: "Revoke using a lowercase decision ID — confirmed",
    stored: [{ type: "decision", sourceStep: 1, terms: ["standups", "9am"], status: "revoked", author: "alice@cli.local" }],
    steps: [
      {
        input: "decision: all standups at 9am",
        captureAs: "DEC",
      },
      {
        input: "revoke {{dec}}",
        assert: "Jeeves confirms that the decision has been revoked or removed",
      },
    ],
  },

  {
    id: "TC-DEC-06",
    description: "Decision with named participants — response references who decided",
    stored: [{ type: "decision", sourceStep: 1, terms: ["Alice", "Bob", "monorepo"], author: "alice@cli.local", decidedBy: [], status: "active" }],
    steps: [
      {
        input: "decision: Alice and Bob agreed we will adopt a monorepo structure for all services",
        captureAs: "DEC",
        replyEquals: "Decision **{{DEC}}** logged: Alice and Bob agreed we will adopt a monorepo structure for all services",
      },
    ],
  },

  {
    id: "TC-DEC-07",
    description: "Retrieved decision — recorder and named decision makers stay distinct",
    stored: [{ type: "decision", sourceStep: 1, terms: ["Carol", "Dave", "Terraform"], author: "alice@cli.local", decidedBy: [], status: "active" }],
    steps: [
      {
        input: "decision: Carol and Dave agreed we will use Terraform for infrastructure provisioning",
        captureAs: "DEC",
      },
      {
        input: "@jeeves tell me about {{DEC}}",
        assert: "Wire Team Bot describes the Terraform decision, names both Carol and Dave as its makers, and identifies Alice as the recorder. It must not label Alice as a decision maker.",
      },
    ],
  },

  // ── Feature 1b: Pipeline extraction path ────────────────────────────────
  // Conversational statements → async pipeline classifies and extracts →
  // @jeeves retrieves via structured or semantic path.

  {
    id: "TC-PIPE-01",
    description: "Pipeline extracts decision from natural conversation",
    steps: [
      // These two lines flow through Tier 1/2 — no explicit command
      "we've agreed to use TypeScript strict mode across the whole codebase",
      "that was the last open question on coding standards",
      {
        input: "@jeeves what did we agree about TypeScript?",
        assert: "Jeeves describes a decision or agreement about TypeScript strict mode",
      },
    ],
  },

  {
    id: "TC-PIPE-02",
    description: "Pipeline extracts action from natural statement",
    steps: [
      "Bob needs to update the deployment runbook before the next release",
      {
        input: "@jeeves what actions are outstanding?",
        assert: "Jeeves mentions Bob or the deployment runbook in the context of outstanding or open actions",
      },
    ],
  },

  // ── Feature 1c: Pipeline lifecycle flows ────────────────────────────────
  // Multi-step, multi-speaker natural conversation flows.  These test that the
  // pipeline correctly attributes actions to the speaker who commits (not the
  // default sender), synthesises decisions from back-and-forth debate, resolves
  // pronouns via the sliding window, and does not duplicate the same item when
  // the same intent is restated.
  //
  // NOTE: the pipeline cannot auto-close an action from natural language today —
  // only an explicit `ACT-xxx done` command closes an action.  TC-PIPE-07
  // acknowledges this by verifying no *new* action is created when a completion
  // is announced, without expecting the original action to disappear.

  {
    id: "TC-PIPE-03",
    description: "Verbal commitment — action attributed to the person who committed",
    steps: [
      // All steps share one process so the sliding window carries both messages.
      { input: "Alice: we need to send our contract template to the new supplier before Friday", shareProcess: true },
      {
        // Bob explicitly commits — pipeline should attribute the action to Bob.
        input: "Bob: I'll take care of that, I'll get it sent over today",
        shareProcess: true,
      },
      {
        input: "@jeeves what are Bob's open actions?",
        shareProcess: true,
        assert: "Jeeves mentions an open action for Bob related to sending a contract or document to the supplier",
      },
    ],
  },

  {
    id: "TC-PIPE-04",
    description: "Decision synthesised from a multi-turn debate",
    steps: [
      { input: "Carol: we're still debating whether to go self-hosted or use a managed Postgres service", shareProcess: true },
      { input: "Dave: the managed service costs more per month but you save on ops time and the SLA is better", shareProcess: true },
      { input: "Carol: fair point — given our team size I think managed is the right call, let's go with that", shareProcess: true },
      {
        input: "@jeeves what did we decide about database hosting?",
        shareProcess: true,
        assert: "Jeeves describes a decision to use a managed Postgres service or managed database hosting",
      },
    ],
  },

  {
    id: "TC-PIPE-05",
    description: "Pronoun resolution and honest handling of an unstored quarter deadline",
    referenceTime: "2026-09-18T15:00:00.000Z", timezone: "UTC",
    stored: [{ type: "action", sourceStep: 1, terms: ["GDPR", "audit"], owner: "alice@cli.local", deadline: null, status: "open" }],
    steps: [
      { input: "Alice is taking the lead on the GDPR data-retention audit", shareProcess: true },
      {
        // "she" and "it" should resolve to Alice and the audit via window context.
        input: "she'll need to have it wrapped up before the end of the quarter",
        shareProcess: true,
      },
      {
        input: "@jeeves what is Alice responsible for?",
        shareProcess: true,
        assert: "Alice is responsible for the GDPR data-retention audit. Any quarter-end deadline is conversational context, not a stored due date. Do not invent a calendar date for it or suggest a command containing an invented calendar date; a <date> placeholder is fine.",
      },
    ],
  },

  {
    id: "TC-PIPE-06",
    description: "Action dedup — an explicit personal commitment restated produces one action",
    stored: [{ type: "action", sourceStep: 1, terms: ["API", "documentation"], owner: "alice@cli.local", status: "open" }],
    steps: [
      // Explicit ownership makes this a positive dedup test, not an inference of
      // responsibility from the sender of an ownerless suggestion.
      "Alice: I will update the API documentation before the next sprint review",
      "Alice: just a reminder that I will update the API documentation before the next sprint review",
      {
        input: "@jeeves what are Alice's open actions?",
        assert: "Jeeves lists Alice's open actions and mentions the API documentation update — it does not list the same task twice or mention two separate API documentation actions",
      },
    ],
  },

  {
    id: "TC-PIPE-07",
    description: "NDA lifecycle — verbal commitment → confirmation → completion announcement does not duplicate",
    steps: [
      // Stage 1: intent raised; Stage 2: Alice commits verbally.
      { input: "Bob: we should send the client our NDA before we proceed any further", shareProcess: true },
      { input: "Alice: I'll handle it — I'll email it over to them today", shareProcess: true },
      {
        // Pipeline should have extracted an action for Alice.
        input: "@jeeves what are Alice's outstanding actions?",
        shareProcess: true,
        assert: "Jeeves mentions an open action for Alice related to the NDA or sending a document to the client",
      },
      // Stage 3: completion announced in natural language.
      // NOTE: this does NOT auto-close the action (pipeline cannot close via NL today).
      // The test verifies only that no *new* open action is created.
      { input: "Alice: update everyone — I've sent the NDA to the client and they've signed and returned it", shareProcess: true },
      {
        input: "@jeeves team actions",
        shareProcess: true,
        assert: "Jeeves does not list a new open action about sending or receiving the NDA — the completion announcement should not have created an additional open action",
      },
    ],
  },

  {
    id: "TC-PIPE-08",
    description: "Ownerless API documentation suggestions do not invent an Alice action",
    stored: [],
    steps: [
      "Alice: we need to update the API documentation before the next sprint review",
      "Alice: just a reminder that the API docs still need updating for the new endpoints",
      { input: "@Wire Team Bot what are Alice's open actions?", assert: "No open action is recorded for Alice. Do not claim she owns the API documentation work merely because she raised it." },
    ],
  },

  // ── Feature 2: Action Management ────────────────────────────────────────

  {
    id: "TC-ACT-01",
    description: "Log an action — gets an ACT reference back",
    steps: [
      {
        input: "action: write the database migration scripts",
        captureAs: "ACT",
        assert: "Jeeves confirms the action was recorded and includes an ACT- reference number",
      },
    ],
  },

  {
    id: "TC-ACT-02",
    description: "Assign action to a named member",
    steps: [
      {
        input: "action: review the open PR for Bob",
        assert: "Jeeves confirms the action was recorded and mentions Bob as the assignee",
      },
    ],
  },

  {
    id: "TC-ACT-03",
    description: "List my actions — includes the previously logged action",
    steps: [
      {
        input: "action: Alice to update the runbook",
        captureAs: "ACT",
      },
      {
        input: "what are my open actions?",
        assert: "The response mentions {{ACT}}",
      },
    ],
  },

  {
    id: "TC-ACT-04",
    description: "List team actions — includes the previously logged action",
    steps: [
      {
        input: "action: Alice to review the infrastructure cost report",
        captureAs: "ACT",
      },
      {
        input: "team actions",
        assert: "Jeeves lists open team actions and includes {{ACT}}",
      },
    ],
  },

  {
    id: "TC-ACT-05",
    description: "Mark action done — confirmed",
    steps: [
      {
        input: "action: deploy the staging environment",
        captureAs: "ACT",
      },
      {
        input: "{{ACT}} done",
        assert: "Jeeves confirms the action has been marked as complete or done",
      },
    ],
  },

  {
    id: "TC-ACT-06",
    description: "Reassign action to another member",
    steps: [
      {
        input: "action: write the release notes",
        captureAs: "ACT",
      },
      {
        input: "{{ACT}} reassign to Bob",
        assert: "Jeeves confirms the action has been reassigned to Bob",
      },
    ],
  },

  {
    id: "TC-ACT-09",
    description: "Pasted inline-code action commands reassign, change deadline and complete",
    referenceTime: "2026-09-18T15:00:00.000Z", timezone: "UTC",
    stored: [{ type: "action", sourceStep: 1, terms: ["formatting", "checklist"], owner: "bob@cli.local", deadline: "2026-09-19T15:00:00.000Z", status: "done" }],
    steps: [
      { input: "action: review the formatting smoke checklist", captureAs: "ACT" },
      { input: "@Wire Team Bot `{{act}} reassign to` @Bob", assert: "The action {{ACT}} was reassigned to Bob. The bot does not claim mentions cannot be used or that it can only read records." },
      { input: "`{{act}} due tomorrow`", assert: "The deadline for {{ACT}} was updated to tomorrow." },
      { input: "`{{act}}` done", assert: "The action {{ACT}} was marked done or completed." },
      { input: "Bob: @Wire Team Bot What is the status and owner of {{act}}?", assert: "Action {{ACT}} belongs to Bob and is done or completed." },
    ],
  },
  {
    id: "TC-ACT-10",
    description: "Addressed named assignment keeps its Friday deadline apart from Monday project context",
    referenceTime: "2026-09-18T09:00:00.000Z", timezone: "UTC",
    stored: [{ type: "action", sourceStep: 1, terms: ["slide", "deck"], owner: "bob@cli.local", deadline: "2026-09-18T12:00:00.000Z", status: "open" }],
    steps: [
      { input: "@Wire Team Bot we really need to get this presentation done by Monday, @Bob needs to prepare the slide deck by this Friday.", captureAs: "ACT", replyEquals: "Action **{{ACT}}** created for **@Bob**: prepare the slide deck (due this Friday: 18 Sept 2026, 12:00)" },
      { input: "@Wire Team Bot team actions", replyEquals: "**@Bob**\n- **{{ACT}}** `open` — prepare the slide deck _(due 2026-09-18)_" },
    ],
  },
  {
    id: "TC-ACT-11",
    description: "A structured member mention keeps today's Friday deadline after noon",
    referenceTime: "2026-09-18T15:00:00.000Z", timezone: "UTC",
    stored: [{ type: "action", sourceStep: 1, terms: ["deck"], owner: "bob@cli.local", deadline: "2026-09-18T12:00:00.000Z", status: "open" }],
    steps: [
      { input: "@Wire Team Bot we really need to get this presentation to Yellow Taxis done by Monday, @Bob really needs to prepare the deck by this Friday", captureAs: "ACT", replyEquals: "Action **{{ACT}}** created for **@Bob**: prepare the deck (due this Friday: 18 Sept 2026, 12:00)" },
      { input: "@Wire Team Bot team actions", replyEquals: "**@Bob**\n- **{{ACT}}** `open` — prepare the deck _(due 2026-09-18)_" },
    ],
  },
  {
    id: "TC-ACT-12",
    description: "Friday uses the conversation calendar when UTC is still Thursday",
    referenceTime: "2026-09-17T23:30:00.000Z", timezone: "Europe/London",
    stored: [{ type: "action", sourceStep: 1, terms: ["timezone", "checklist"], owner: "bob@cli.local", deadline: "2026-09-18T11:00:00.000Z", status: "open" }],
    steps: [{ input: "action: review the timezone checklist for Bob by this Friday", assert: "An action was created for Bob to review the timezone checklist, due Friday 18 September 2026. It must not move to Friday 25 September." }],
  },
  {
    id: "TC-ACT-13",
    description: "Explicit next Friday remains next week in the conversation timezone",
    referenceTime: "2026-09-18T15:00:00.000Z", timezone: "Europe/London",
    stored: [{ type: "action", sourceStep: 1, terms: ["next week", "checklist"], owner: "bob@cli.local", deadline: "2026-09-25T11:00:00.000Z", status: "open" }],
    steps: [{ input: "action: review the next week checklist for Bob by next Friday", assert: "An action was created for Bob to review the checklist, due Friday 25 September 2026. It must not use Friday 18 September." }],
  },
  {
    id: "TC-ACT-07",
    description: "Action with owner and due date — both present in response",
    steps: [
      {
        input: "action: Carol to write the API documentation by end of month",
        captureAs: "ACT",
        assert: "Jeeves confirms the action was recorded with an ACT- reference, identifies Carol as the assignee, and mentions end of month or March as the deadline",
      },
    ],
  },

  {
    id: "TC-ACT-08",
    description: "Action with specific date — deadline is correct in response",
    steps: [
      {
        input: "action: Dave to complete the security audit by April 3rd",
        captureAs: "ACT",
        assert: "Jeeves confirms the action was recorded with an ACT- reference, names Dave as the owner, and references April 3rd or a date close to that as the deadline",
      },
    ],
  },

  // ── Feature 2b: Identity and attribution ────────────────────────────────
  // Tests that "my actions / reminders / decisions" are correctly scoped to the
  // caller, that named-member attribution works, and that team queries return
  // everyone's items.  Steps use the "Name: message" CLI format to vary the
  // sender.

  {
    id: "TC-ID-01",
    description: "My actions returns caller's actions only — not other members'",
    steps: [
      {
        // Alice (default sender) logs her own action
        input: "action: Alice to update the security documentation",
        captureAs: "ACT",
      },
      {
        // Bob logs his own action
        input: "Bob: action: Bob to refactor the payment module",
      },
      {
        // Query as Alice — should see her action, not Bob's
        input: "@jeeves what are my open actions?",
        assert: "The response is a list of open actions containing {{ACT}}; it does not mention Bob or payment module",
      },
    ],
  },

  {
    id: "TC-ID-02",
    description: "Actions for a named member returns that member's actions only",
    steps: [
      {
        input: "action: Alice to prepare the sprint retrospective slides",
      },
      {
        input: "Bob: action: Bob to deploy the hotfix to staging",
        captureAs: "ACT",
      },
      {
        input: "@jeeves what actions does Bob have?",
        assert: "Jeeves lists Bob's open actions including {{ACT}} and does NOT include Alice's retrospective slides action",
      },
    ],
  },

  {
    id: "TC-ID-03",
    description: "Decision recorder identity is reported without inventing a decision maker",
    stored: [{ type: "decision", sourceStep: 1, terms: ["semantic", "versioning"], author: "alice@cli.local", decidedBy: [], status: "active" }],
    steps: [
      {
        input: "Alice: decision: we will enforce semantic versioning for all internal packages",
        captureAs: "DEC",
        assert: "Jeeves confirms the decision was recorded with a DEC- reference",
      },
      {
        input: "@Wire Team Bot who recorded {{DEC}}?",
        assert: "Wire Team Bot identifies Alice as the recorder of the decision. It must not infer that she made it.",
      },
      {
        input: "@Wire Team Bot who made {{DEC}}?",
        assert: "Wire Team Bot says the decision makers are not recorded or cannot be identified. It may name Alice as recorder, but must not claim she made the decision",
      },
    ],
  },

  {
    id: "TC-ID-04",
    description: "My reminders returns only the caller's reminders — not others'",
    steps: [
      {
        // Alice sets a reminder for herself
        input: "Alice: remind me on Thursday to chase the vendor invoice",
        captureAs: "REM",
        assert: "Jeeves confirms the reminder was set with a REM- reference for Thursday",
      },
      {
        // Bob sets a separate reminder for himself
        input: "Bob: remind me on Friday to send the weekly report",
      },
      {
        // Alice queries — should see only her own Thursday reminder
        input: "@jeeves what reminders do I have?",
        assert: "Jeeves lists Alice's reminders including {{REM}} for Thursday and does NOT include Bob's Friday report reminder",
      },
    ],
  },

  {
    id: "TC-ID-05",
    description: "Team actions lists all members' actions — not just the caller's",
    steps: [
      {
        input: "action: Alice to write the API specification",
        captureAs: "ACT",
      },
      {
        input: "Bob: action: Bob to set up the CI pipeline",
      },
      {
        input: "@jeeves team actions",
        assert: "Jeeves lists open team actions including both Alice's API specification action ({{ACT}}) and Bob's CI pipeline action",
      },
    ],
  },

  // ── Feature 3: Reminders ────────────────────────────────────────────────

  {
    id: "TC-REM-07",
    description: "Reminder create, list and snooze display the configured timezone",
    referenceTime: "2026-09-21T11:00:00.000Z", timezone: "Europe/London",
    stored: [{ type: "reminder", sourceStep: 1, terms: ["timezone", "smoke"], owner: "alice@cli.local", deadline: "2026-09-21T11:02:00.000Z", status: "cancelled" }],
    steps: [
      { input: "remind me in 20 minutes to check timezone smoke", captureAs: "REM", replyEquals: "Reminder **{{REM}}** set for **Monday, 21 Sept 2026, 12:20 BST**: check timezone smoke" },
      { input: "show reminders", replyEquals: "- **{{REM}}** — check timezone smoke _(Monday, 21 Sept 2026, 12:20 BST)_" },
      { input: "snooze {{rem}} 2 minutes", replyEquals: "**{{REM}}** snoozed until **21 Sept 2026, 12:02 BST**." },
      { input: "cancel {{rem}}", replyEquals: "**{{REM}}** cancelled." },
    ],
  },

  {
    id: "TC-REM-06",
    description: "Pasted reminder commands create, list, snooze and cancel",
    steps: [
      { input: "@Wire Team Bot `remind me in 2 minutes to check the formatting smoke reminder`", captureAs: "REM", assert: "A reminder was scheduled to check the formatting smoke reminder, with a REM reference and time. The bot must not merely explain syntax or say it cannot schedule." },
      { input: "@Wire Team Bot `show reminders`", assert: "The reminder list contains {{REM}} for checking the formatting smoke reminder." },
      { input: "@Wire Team Bot `snooze {{rem}} 1 hour`", assert: "Reminder {{REM}} was snoozed and a new time is confirmed." },
      { input: "@Wire Team Bot `cancel {{rem}}`", assert: "Reminder {{REM}} was cancelled." },
    ],
  },

  {
    id: "TC-REM-01",
    description: "Create a reminder — confirmed",
    steps: [
      {
        input: "remind me tomorrow to review the deployment checklist",
        captureAs: "REM",
        assert: "Jeeves confirms a reminder has been set and includes a date or time for when it will fire",
      },
    ],
  },

  {
    id: "TC-REM-02",
    description: "List reminders — includes the previously created reminder",
    steps: [
      {
        input: "remind me next Tuesday to send the weekly status report",
        captureAs: "REM",
      },
      {
        input: "what reminders do I have?",
        assert: "Jeeves lists reminders and includes {{REM}}",
      },
    ],
  },

  {
    id: "TC-REM-03",
    description: "Cancel a reminder — confirmed",
    steps: [
      {
        input: "remind me in 2 days to update the docs",
        captureAs: "REM",
      },
      {
        input: "cancel {{REM}}",
        assert: "Jeeves confirms the reminder has been cancelled or removed",
      },
    ],
  },

  {
    id: "TC-REM-04",
    description: "Reminder with specific date — date is accurate in confirmation",
    steps: [
      {
        input: "remind me on April 5th to submit the quarterly report",
        captureAs: "REM",
        assert: "Jeeves confirms a reminder was set with a REM- reference and mentions April 5th or a date matching April 5th as when it will fire",
      },
    ],
  },

  {
    id: "TC-REM-05",
    description: "Reminder with day and time — both preserved in confirmation",
    steps: [
      {
        input: "remind me next Monday at 9am to prepare the sprint review slides",
        captureAs: "REM",
        assert: "Jeeves confirms the reminder with a REM- reference and specifies both a day (Monday) and time (9am or 09:00) in the confirmation",
      },
    ],
  },

  // ── Feature 4: Q&A and Context Awareness ────────────────────────────────

  {
    id: "TC-QA-01",
    description: "Answer a question from recent conversation context",
    steps: [
      // All three steps share one process so the sliding window contains the context
      { input: "we decided to use Redis for the session cache", shareProcess: true },
      { input: "the main reason was that Redis supports TTL natively", shareProcess: true },
      {
        input: "@jeeves what are we using for the session cache and why?",
        shareProcess: true,
        assert: "Jeeves answers that Redis is being used for the session cache and mentions TTL as a reason",
      },
    ],
  },

  {
    id: "TC-QA-02",
    description: "Answer from a logged decision",
    steps: [
      {
        input: "decision: all API responses must use JSON:API format",
        captureAs: "DEC",
      },
      {
        input: "@jeeves what format should our API responses use?",
        assert: "Jeeves answers that API responses should use JSON:API format",
      },
    ],
  },

  {
    id: "TC-QA-03",
    description: "General knowledge question — answered, not 'no record'",
    steps: [
      {
        input: "@jeeves what is the difference between TCP and UDP?",
        assert: "Jeeves gives a factual answer about TCP and UDP without saying it has no record of them",
      },
    ],
  },

  {
    id: "TC-QA-04",
    description: "Meta question — describes capabilities",
    steps: [
      {
        input: "@jeeves what kind of information do you keep track of?",
        assert: "Jeeves describes the types of things it tracks, such as decisions, actions, or reminders",
      },
    ],
  },

  {
    id: "TC-QA-05",
    description: "Follow-up yes stays coherent and read-only",
    stored: [],
    steps: [
      // Both steps share one CLI process so conversation context persists
      { input: "@jeeves shall I create a reminder to review the deployment checklist?", shareProcess: true },
      {
        input: "@jeeves yes",
        shareProcess: true,
        assert: "Continue the deployment-checklist reminder conversation by supplying a supported reminder command or asking for missing timing. Do not claim a reminder was scheduled or say there is no record of the conversation.",
      },
    ],
  },

  // ── Feature 5: Channel State Machine ────────────────────────────────────

  {
    id: "TC-STATE-01",
    description: "Pause — bot acknowledges and steps out",
    steps: [
      {
        input: "@jeeves pause",
        assert: "Jeeves acknowledges the pause instruction and indicates it will stop monitoring or step back",
      },
    ],
  },

  {
    id: "TC-STATE-02",
    description: "Pause then resume — bot confirms it is active again",
    steps: [
      "@jeeves pause",
      {
        input: "@jeeves resume",
        assert: "Jeeves confirms it has resumed and is active again",
      },
    ],
  },

  {
    id: "TC-STATE-03",
    description: "Secure mode — acknowledgement matches the persisted state",
    stored: [], channelState: "secure",
    steps: [
      {
        input: "@jeeves secure mode",
        replyEquals: "Of course. I have cleared my short-term recollection of this channel and shall disregard all proceedings until further notice.",
      },
    ],
  },

  // ── Feature 6: Persona and Response Quality ─────────────────────────────

  {
    id: "TC-PERSONA-01",
    description: "No exclamation marks or invented decision-maker pronouns",
    stored: [{ type: "decision", sourceStep: 1, terms: ["agile", "methodology"], author: "alice@cli.local", decidedBy: [], status: "active" }],
    steps: [
      {
        input: "decision: we will adopt agile methodology",
        captureAs: "DEC",
      },
      {
        input: "@jeeves what did we decide about our methodology?",
        assert: "Describe the recorded agile-methodology decision without exclamation marks. Alice is only the recorder; decision makers are unknown. Do not identify Alice or the requester as a maker, including introductory wording such as you decided or your decision. You may omit maker attribution or explicitly say it is not recorded.",
      },
    ],
  },

  {
    id: "TC-PERSONA-02",
    description: "No hollow opener — no 'Certainly', 'Of course', 'Great question'",
    steps: [
      {
        input: "@jeeves what is continuous integration?",
        assert: "Jeeves answers without starting with hollow affirmations like Certainly, Of course, Great question, or Absolutely",
      },
    ],
  },

  {
    id: "TC-PERSONA-03",
    description: "Error case uses 'I'm afraid' phrasing, not 'Sorry'",
    steps: [
      {
        input: "@jeeves who attended the board meeting last Tuesday?",
        assert: "Jeeves does not begin its response with 'Sorry' — it may use 'I'm afraid' or similar but not an apology opener",
      },
    ],
  },

  // ── Feature 7: Inverse tests — false-positive prevention ────────────────
  // These verify that general chat, hypotheticals, questions, and past events
  // are NOT incorrectly recognised as decisions or actions.

  {
    id: "TC-NEG-DEC-01",
    description: "Hypothetical discussion is not recorded as a decision",
    steps: [
      "we're considering switching to Kubernetes at some point, but nothing is confirmed yet",
      "it's just an idea on the table for now",
      {
        input: "@jeeves have we made any decisions about Kubernetes?",
        assert: "Jeeves indicates there is no confirmed decision about Kubernetes — it may acknowledge it came up as a discussion or idea but does not report it as a firm decision",
      },
    ],
  },

  {
    id: "TC-NEG-DEC-02",
    description: "Open question is not logged as a decision",
    steps: [
      "should we use TypeScript or JavaScript for the new service? What does everyone think?",
      {
        input: "@jeeves what did we decide about TypeScript versus JavaScript for the new service?",
        assert: "Jeeves indicates no decision has been recorded about TypeScript versus JavaScript — it recognises this was a question, not a confirmed decision",
      },
    ],
  },

  {
    id: "TC-NEG-DEC-03",
    description: "Status update is not logged as a decision",
    steps: [
      "we deployed to production successfully this morning, no issues reported",
      {
        input: "@jeeves list decisions",
        assert: "Jeeves does not include the production deployment as a decision — a deployment status update is not a decision",
      },
    ],
  },

  {
    id: "TC-NEG-DEC-04",
    description: "Announcement of a fact is not logged as a decision",
    steps: [
      "the office will be closed on the 25th for a public holiday",
      {
        input: "@jeeves list decisions",
        assert: "Jeeves does not list the office closure announcement as a decision — an informational notice about a public holiday is not a decision",
      },
    ],
  },

  {
    id: "TC-NEG-ACT-01",
    description: "Completed past activity does not become an open action",
    steps: [
      "Bob submitted the quarterly report last Tuesday, it's all done",
      {
        input: "@jeeves what are Bob's open actions?",
        assert: "Jeeves indicates Bob has no open actions from this exchange — a completed past activity is not an open action",
      },
    ],
  },

  {
    id: "TC-NEG-ACT-02",
    description: "Vague ownerless suggestion is not logged as an action",
    steps: [
      "it would be nice if someone eventually updated the wiki, no rush",
      {
        input: "@jeeves team actions",
        assert: "Jeeves does not list a wiki update as an open action — a vague suggestion without a clear owner or commitment is not an action",
      },
    ],
  },

  {
    id: "TC-NEG-ACT-03",
    description: "Social greeting chat does not produce actions",
    steps: [
      "morning everyone, hope you all had a good weekend!",
      "looking forward to the team lunch on Friday",
      {
        input: "@jeeves team actions",
        assert: "Jeeves does not extract any actions from the social messages — casual greetings and social chat are not actions",
      },
    ],
  },

  {
    id: "TC-NEG-ACT-04",
    description: "General status update about ongoing work is not an action",
    steps: [
      "I've been working on the auth refactor this week, making good progress",
      {
        input: "@jeeves team actions",
        assert: "Jeeves does not list an auth refactor action from the general progress update — a status update is not a new action commitment",
      },
    ],
  },

  {
    id: "TC-NEG-CHAT-01",
    description: "General chat thread produces no false decisions or actions",
    steps: [
      "anyone seen the new Figma update? looks interesting",
      "yeah it's pretty nice, though I haven't had time to dig into it",
      "same here, maybe we can look at it next week",
      {
        input: "@jeeves list decisions",
        assert: "Jeeves reports no decisions were recorded — a casual chat exchange about a tool is not a decision",
      },
    ],
  },

  {
    id: "TC-NEG-CHAT-02",
    description: "Meeting small-talk produces no false actions",
    steps: [
      "shall we kick things off?",
      "sure, let's go",
      "great, first let's go round the room with updates",
      {
        input: "@jeeves team actions",
        assert: "Jeeves reports no actions were extracted from the meeting small-talk — procedural chat about starting a meeting is not an action",
      },
    ],
  },

  {
    id: "TC-NEG-ACT-05",
    description: "First-person completion announcement is not logged as an open action",
    steps: [
      // Alice announces she has just finished something — this is a completion, not a new commitment.
      "Alice: I've just finished writing the technical specifications, they're in the shared folder now",
      {
        input: "@jeeves what are Alice's open actions?",
        assert: "Jeeves does not list an open action about writing technical specifications — a first-person announcement of completed work is not a new action",
      },
    ],
  },

  {
    id: "TC-NEG-ACT-06",
    description: "Team past-tense completion is not logged as an open action",
    steps: [
      // Collective past-tense completion — no ongoing commitment implied.
      "we signed the vendor contract yesterday, everything is all sorted",
      {
        input: "@jeeves team actions",
        assert: "Jeeves does not list an open action about signing a contract — a past-tense completion announcement is not a new open action",
      },
    ],
  },

  {
    id: "TC-ID-06",
    description: "Current caller remains Bob after Alice's questions in the same conversation",
    referenceTime: "2026-09-18T15:00:00.000Z", timezone: "UTC",
    stored: [
      { type: "action", sourceStep: 1, terms: ["launch", "checklist"], owner: "bob@cli.local", deadline: "2026-09-18T12:00:00.000Z", status: "open" },
      { type: "action", sourceStep: 2, terms: ["retrospective", "slides"], owner: "alice@cli.local", deadline: null, status: "open" },
    ],
    steps: [
      { input: "Alice: action: review the launch checklist for Bob by Friday", captureAs: "ACT", shareProcess: true },
      { input: "Alice: action: prepare the retrospective slides", shareProcess: true },
      { input: "Alice: @Wire Team Bot What am I responsible for here?", shareProcess: true },
      {
        input: "Bob: @Wire Team Bot What am I responsible for here?", shareProcess: true,
        assert: "The current requester is Bob. The answer says Bob (or you) owns the launch checklist action {{ACT}}. It must not address Alice as the requester, say Bob has no assigned actions, or present Alice's retrospective-slides action as Bob's.",
      },
    ],
  },
];
