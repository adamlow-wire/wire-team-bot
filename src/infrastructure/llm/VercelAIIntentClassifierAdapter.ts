/**
 * VercelAIIntentClassifierAdapter
 *
 * Uses the "classify" model slot to convert a user's natural-language command
 * into a structured Intent object (via generateObject + IntentSchema).
 *
 * Hard timeout of 500 ms (configurable) so the router is never blocked by a
 * slow inference endpoint.  On timeout or any error, returns { type: "unknown" }.
 */

import { generateObject } from "ai";
import type { IntentClassifierPort } from "../../application/ports/IntentClassifierPort";
import { IntentSchema } from "../../domain/schemas/intent";
import type { Intent } from "../../domain/schemas/intent";
import type { VercelAISlotFactory } from "./VercelAISlotFactory";

const SYSTEM_PROMPT = `You are an intent classifier for a team-assistant bot.
Classify the user's message into exactly one of the following intents:

- create_decision: log/record a team decision (summary required; supersedesRef if it replaces an older one)
- create_action: create/assign a task or action item (description required; assigneeRef if assigning to someone)
- supersede_decision: create a new decision that supersedes an existing one (newSummary + supersedesRef required)
- revoke_decision: revoke/cancel a decision (targetRef = DEC-NNNN or description; optional reason)
- update_action_status: mark an action as done, cancelled, or in_progress (targetRef + status required)
- reassign_action: reassign an action to someone else (targetRef + newAssigneeRef required)
- update_action_deadline: set or update an action's deadline (targetRef + deadlineExpression required)
- set_reminder: create a reminder (timeExpression + description required)
- cancel_reminder: cancel a reminder (targetRef = REM-NNNN or description)
- snooze_reminder: snooze a reminder (targetRef + snoozeExpression required)
- list_my_actions: show the user's own assigned actions
- list_team_actions: show all open team actions
- list_overdue_actions: show overdue actions
- list_decisions: list recent decisions
- search_decisions: search decisions by keyword (query required)
- list_my_reminders: show the user's reminders
- unknown: none of the above (general question, greeting, unclear command)

Extract parameters from the message as precisely as possible.
Use "unknown" only when the message is clearly a question or does not match any command intent.`;

export class VercelAIIntentClassifierAdapter implements IntentClassifierPort {
  constructor(
    private readonly factory: VercelAISlotFactory,
    private readonly timeoutMs: number = 500,
  ) {}

  async classify(text: string, conversationContext: string[] = []): Promise<Intent> {
    const model = this.factory.getModel("classify");
    const contextStr = conversationContext.length > 0
      ? `\nRecent conversation:\n${conversationContext.slice(-3).join("\n")}\n`
      : "";

    try {
      const result = await Promise.race<{ object: Intent }>([
        generateObject({
          model,
          schema: IntentSchema,
          system: SYSTEM_PROMPT,
          prompt: `${contextStr}\nUser message: "${text}"`,
          maxRetries: 0,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("intent-classifier-timeout")), this.timeoutMs),
        ),
      ]);
      return result.object;
    } catch {
      return { type: "unknown", params: {} };
    }
  }
}
