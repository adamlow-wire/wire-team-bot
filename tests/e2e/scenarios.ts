/**
 * E2E scenarios for Jeeves.
 *
 * Inputs are natural language — the way team members actually talk.
 * Assertions are plain English describing what a correct response looks like.
 * The LLM judge evaluates each assertion; no regexes.
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
    description: "List decisions — returns results or a sensible empty state",
    steps: [
      {
        input: "list decisions",
        assert: "Jeeves either lists one or more decisions with DEC- references, or states that no decisions have been recorded",
      },
    ],
  },

  {
    id: "TC-DEC-04",
    description: "Supersede a decision — old marked, new logged",
    steps: [
      {
        input: "decision: we will deploy on Fridays",
        captureAs: "DEC",
      },
      {
        input: "decision: we will never deploy on Fridays supersedes {{DEC}}",
        assert: "Jeeves confirms that the previous decision has been superseded and records the new one with a DEC- reference",
      },
    ],
  },

  {
    id: "TC-DEC-05",
    description: "Revoke a decision — confirmed",
    steps: [
      {
        input: "decision: all standups at 9am",
        captureAs: "DEC",
      },
      {
        input: "revoke {{DEC}}",
        assert: "Jeeves confirms that the decision has been revoked or removed",
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
        assert: "Jeeves lists open actions or states there are none — any coherent response about action status is acceptable",
      },
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
    description: "List my actions — returns open actions or empty",
    steps: [
      {
        input: "action: Alice to update the runbook",
        captureAs: "ACT",
      },
      {
        input: "what are my open actions?",
        assert: "Jeeves lists open actions assigned to Alice, or states there are none",
      },
    ],
  },

  {
    id: "TC-ACT-04",
    description: "List team actions — all open actions or empty",
    steps: [
      {
        input: "team actions",
        assert: "Jeeves either lists all open team actions with ACT- references, or states there are no open actions",
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

  // ── Feature 3: Reminders ────────────────────────────────────────────────

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
    description: "List reminders — returns list or empty",
    steps: [
      {
        input: "what reminders do I have?",
        assert: "Jeeves either lists upcoming reminders with REM- references, or states there are no reminders scheduled",
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
    description: "Follow-up 'yes' is coherent — not a no-record fallback",
    steps: [
      // Both steps share one CLI process so conversation context persists
      { input: "@jeeves shall I create a reminder to review the deployment checklist?", shareProcess: true },
      {
        input: "@jeeves yes",
        shareProcess: true,
        assert: "Jeeves responds coherently to the follow-up — either creates a reminder or continues the prior conversation — and does not say it has no record",
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
    description: "Secure mode — bot confirms context cleared",
    steps: [
      {
        input: "@jeeves secure mode",
        assert: "Jeeves acknowledges secure mode and indicates the conversation context has been cleared or disregarded",
      },
    ],
  },

  // ── Feature 6: Persona and Response Quality ─────────────────────────────

  {
    id: "TC-PERSONA-01",
    description: "No exclamation marks in any response",
    steps: [
      {
        input: "decision: we will adopt agile methodology",
        captureAs: "DEC",
      },
      {
        input: "@jeeves what did we decide about our methodology?",
        assert: "Jeeves responds without using any exclamation marks",
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

];
