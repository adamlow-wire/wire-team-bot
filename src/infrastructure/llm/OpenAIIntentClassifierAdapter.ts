import type { IntentClassifierService, IntentResult, IntentPayload } from "../../domain/services/IntentClassifierService";
import type { LLMConfig } from "./LLMConfigAdapter";
import type { Logger } from "../../application/ports/Logger";

const SYSTEM_PROMPT = `You are an intent classifier for a team collaboration bot. Classify the user message into exactly one intent and extract relevant payload fields.

INTENTS:
- create_task: User wants to create/add a new task or to-do item (e.g. "we need to write the spec", "task: build the API")
- update_task_status: User wants to change the status of an EXISTING task identified by a TASK-NNNN ID (e.g. "close TASK-0001", "done TASK-0002", "mark TASK-0003 as complete", "TASK-0001 done", "cancel TASK-0002"). Extract entityId (the TASK-NNNN) and newStatus ("done", "cancelled", "in_progress").
- create_decision: User wants to record a decision that was made (e.g. "we've decided to use Postgres", "decision: go with option A")
- create_action: User wants to create a NEW action item — something a specific person must do (e.g. "John should follow up on the contract", "action: Emil to review the PR"). Do NOT use this if a TASK/ACT/DEC ID is mentioned.
- update_action_status: User wants to change the status of an EXISTING action identified by an ACT-NNNN ID (e.g. "close ACT-0001", "done ACT-0002", "mark ACT-0003 as complete", "ACT-0001 done", "cancel ACT-0002", "complete ACT-0003"). Extract entityId (the ACT-NNNN) and newStatus ("done", "cancelled", "in_progress"). "close" and "complete" map to "done".
- reassign_action: User wants to reassign an EXISTING action (ACT-NNNN) to someone else (e.g. "assign ACT-0001 to Mark", "ACT-0002 reassign to Sarah", "give ACT-0003 to John"). Extract entityId (the ACT-NNNN) and newAssignee (the person's name or @mention).
- create_reminder: User wants a reminder at a future time (e.g. "remind me at 3pm to call John", "reminder in 2 hours check the build")
- store_knowledge: User wants to store/remember/note a fact (e.g. "remember that Schwarz have 10k users", "note: rate limit is 100/min", "remember this", "store that")
- retrieve_knowledge: User is asking a QUESTION seeking information the bot may have stored (e.g. "what is our rate limit?", "how do we handle auth?", "what's the onboarding process?", "do we have a decision on X?"). Do NOT use this for statements, answers, or confirmations — "Yes we did", "We decided X", "The meeting is on Friday" are NOT retrieve_knowledge.
- list_my_tasks: User wants to see their own tasks (e.g. "my tasks", "what am I working on?", "show my tasks")
- list_decisions: User wants to see or search decisions (e.g. "list decisions", "what decisions were made about migration?", "decisions about pricing")
- list_my_actions: User wants to see their own actions (e.g. "my actions", "what do I need to do?", "show actions")
- list_team_actions: User wants to see all team actions (e.g. "team actions", "what is the team working on?", "show all actions")
- list_reminders: User wants to see their pending reminders (e.g. "show reminders", "my reminders", "list reminders", "what reminders do I have?")
- help: User is asking what the bot does or how to use it (e.g. "what can you do?", "help", "how do I use this?", "what are you?")
- secret_mode_on: User wants the bot to stop listening (e.g. "secret mode", "go quiet", "stop listening", "this is sensitive", "private conversation", "pause")
- secret_mode_off: User wants the bot to resume (e.g. "resume", "come back", "you can listen again", "start listening", "unpause")
- none: General conversation not directed at the bot — reactions, acknowledgements, chit-chat

PAYLOAD FIELDS (include only relevant ones, omit null/undefined):
- description: task or action description text (for create intents only)
- summary: decision summary text
- assignee: @mention or name string if specified (for create_action only)
- deadline: natural language date string if mentioned (e.g. "Friday", "March 20"), omit if not mentioned
- priority: "high", "normal", or "low" only if explicitly stated, omit otherwise
- timeExpression: for create_reminder — the natural language time (e.g. "tomorrow at 9am", "in 2 hours", "Friday at 3pm")
- query: search/lookup terms for retrieve_knowledge or list_decisions
- usePreviousMessage: true ONLY when user says "remember this/that/it" or "store that/this" without specifying content
- entityId: for update_task_status, update_action_status, reassign_action — the TASK-NNNN or ACT-NNNN identifier
- newStatus: for update_task_status, update_action_status — "done", "cancelled", or "in_progress"
- newAssignee: for reassign_action — the new assignee name or @mention

Return only valid JSON, no markdown:
{"intent":"<intent>","confidence":<0.0-1.0>,"payload":{<fields>}}`;

export class OpenAIIntentClassifierAdapter implements IntentClassifierService {
  constructor(private readonly config: LLMConfig, private readonly logger: Logger) {}

  async classify(text: string, previousMessageText?: string): Promise<IntentResult> {
    if (!this.config.enabled || !this.config.apiKey) {
      return { intent: "none", payload: {}, confidence: 1.0 };
    }

    const userContent = previousMessageText
      ? `Previous message: "${previousMessageText}"\nCurrent message: "${text}"`
      : `Message: "${text}"`;

    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: 200,
      temperature: 0,
    };

    this.logger.debug("Intent classifier called", { text: text.slice(0, 80), hasPrevious: !!previousMessageText });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Intent classifier LLM request failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { intent: "none", payload: {}, confidence: 0 };

    let parsed: { intent?: string; confidence?: number; payload?: IntentPayload };
    try {
      parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, "").trim()) as typeof parsed;
    } catch {
      this.logger.warn("Intent classifier — failed to parse LLM response", { preview: content.slice(0, 200) });
      return { intent: "none", payload: {}, confidence: 0 };
    }

    const intent = parsed.intent as IntentResult["intent"] | undefined;
    const validIntents: IntentResult["intent"][] = [
      "create_task", "update_task_status", "create_decision",
      "create_action", "update_action_status", "reassign_action", "create_reminder",
      "store_knowledge", "retrieve_knowledge", "list_my_tasks", "list_decisions",
      "list_my_actions", "list_team_actions", "list_reminders",
      "help", "secret_mode_on", "secret_mode_off", "none",
    ];
    if (!intent || !validIntents.includes(intent)) {
      return { intent: "none", payload: {}, confidence: 0 };
    }

    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0)));
    const result: IntentResult = { intent, payload: parsed.payload ?? {}, confidence };

    this.logger.debug("Intent classified", { intent: result.intent, confidence: result.confidence });
    return result;
  }
}
