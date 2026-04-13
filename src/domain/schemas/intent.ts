/**
 * Structured intent schema — the output of the LLM intent classifier.
 *
 * Each intent maps to one or more use-cases executed by IntentToolExecutor.
 * targetRef / assigneeRef / newAssigneeRef are always natural-language strings;
 * the executor resolves them to entity IDs (or passes them through if they already
 * look like ACT-NNNN, DEC-NNNN, REM-NNNN).
 */

import { z } from "zod";

// ── Write intents ──────────────────────────────────────────────────────────

const CreateDecisionIntent = z.object({
  type: z.literal("create_decision"),
  params: z.object({
    summary: z.string().min(1),
    /** Present when the new decision explicitly replaces an older one. */
    supersedesRef: z.string().optional(),
  }),
});

const CreateActionIntent = z.object({
  type: z.literal("create_action"),
  params: z.object({
    description: z.string().min(1),
    /** NL name or "me" — executor resolves to a member. */
    assigneeRef: z.string().optional(),
  }),
});

const SupersedeDecisionIntent = z.object({
  type: z.literal("supersede_decision"),
  params: z.object({
    newSummary: z.string().min(1),
    /** DEC-NNNN or NL reference to the decision being superseded. */
    supersedesRef: z.string().min(1),
  }),
});

const RevokeDecisionIntent = z.object({
  type: z.literal("revoke_decision"),
  params: z.object({
    /** DEC-NNNN or NL reference. */
    targetRef: z.string().min(1),
    reason: z.string().optional(),
  }),
});

const UpdateActionStatusIntent = z.object({
  type: z.literal("update_action_status"),
  params: z.object({
    /** ACT-NNNN or NL description of the action. */
    targetRef: z.string().min(1),
    status: z.enum(["done", "cancelled", "in_progress"]),
    note: z.string().optional(),
  }),
});

const ReassignActionIntent = z.object({
  type: z.literal("reassign_action"),
  params: z.object({
    targetRef: z.string().min(1),
    newAssigneeRef: z.string().min(1),
  }),
});

const UpdateActionDeadlineIntent = z.object({
  type: z.literal("update_action_deadline"),
  params: z.object({
    targetRef: z.string().min(1),
    /** Human-readable time expression, e.g. "next Friday", "in 3 days". */
    deadlineExpression: z.string().min(1),
  }),
});

const SetReminderIntent = z.object({
  type: z.literal("set_reminder"),
  params: z.object({
    /** Human-readable time expression, e.g. "tomorrow at 9am", "in 2 hours". */
    timeExpression: z.string().min(1),
    description: z.string().min(1),
  }),
});

const CancelReminderIntent = z.object({
  type: z.literal("cancel_reminder"),
  params: z.object({
    /** REM-NNNN or NL description. */
    targetRef: z.string().min(1),
  }),
});

const SnoozeReminderIntent = z.object({
  type: z.literal("snooze_reminder"),
  params: z.object({
    targetRef: z.string().min(1),
    snoozeExpression: z.string().min(1),
  }),
});

// ── Read / list intents ───────────────────────────────────────────────────

const ListMyActionsIntent = z.object({
  type: z.literal("list_my_actions"),
  params: z.object({}),
});

const ListTeamActionsIntent = z.object({
  type: z.literal("list_team_actions"),
  params: z.object({}),
});

const ListOverdueActionsIntent = z.object({
  type: z.literal("list_overdue_actions"),
  params: z.object({}),
});

const ListDecisionsIntent = z.object({
  type: z.literal("list_decisions"),
  params: z.object({}),
});

const SearchDecisionsIntent = z.object({
  type: z.literal("search_decisions"),
  params: z.object({
    query: z.string().min(1),
  }),
});

const ListMyRemindersIntent = z.object({
  type: z.literal("list_my_reminders"),
  params: z.object({}),
});

// ── Fallback ──────────────────────────────────────────────────────────────

const UnknownIntent = z.object({
  type: z.literal("unknown"),
  params: z.object({}),
});

// ── Discriminated union ────────────────────────────────────────────────────

export const IntentSchema = z.discriminatedUnion("type", [
  CreateDecisionIntent,
  CreateActionIntent,
  SupersedeDecisionIntent,
  RevokeDecisionIntent,
  UpdateActionStatusIntent,
  ReassignActionIntent,
  UpdateActionDeadlineIntent,
  SetReminderIntent,
  CancelReminderIntent,
  SnoozeReminderIntent,
  ListMyActionsIntent,
  ListTeamActionsIntent,
  ListOverdueActionsIntent,
  ListDecisionsIntent,
  SearchDecisionsIntent,
  ListMyRemindersIntent,
  UnknownIntent,
]);

export type Intent = z.infer<typeof IntentSchema>;
export type IntentType = Intent["type"];
