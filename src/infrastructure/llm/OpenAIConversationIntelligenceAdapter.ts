import type {
  ConversationIntelligenceService,
  ConversationIntelligenceInput,
  ConversationIntelligenceResult,
  CaptureCandidate,
} from "../../domain/services/ConversationIntelligenceService";
import type { IntentType, IntentPayload } from "../../domain/services/IntentClassifierService";
import type { LLMConfig } from "./LLMConfigAdapter";
import type { Logger } from "../../application/ports/Logger";

const SYSTEM_PROMPT = `You are a conversation intelligence service for a team collaboration bot. Given a message, you must simultaneously:
1. Classify the user's intent
2. Detect if there is anything worth passively capturing
3. Decide whether the bot should respond

INTENTS:
- create_task: User wants to create/add a new task or to-do item (e.g. "we need to write the spec", "task: build the API")
- update_task_status: User wants to change the status of an EXISTING task identified by a TASK-NNNN ID (e.g. "close TASK-0001", "done TASK-0002", "mark TASK-0003 as complete", "TASK-0001 done", "cancel TASK-0002"). Extract entityId (the TASK-NNNN) and newStatus ("done", "cancelled", "in_progress").
- create_decision: User wants to record a decision that was made (e.g. "we've decided to use Postgres", "decision: go with option A")
- create_action: User wants to create a NEW action item — something a specific person must do (e.g. "John should follow up on the contract", "action: Emil to review the PR"). Do NOT use this if a TASK/ACT/DEC ID is mentioned.
- update_action_status: User wants to change the status of an EXISTING action identified by an ACT-NNNN ID (e.g. "close ACT-0001", "done ACT-0002", "mark ACT-0003 as complete", "ACT-0001 done", "cancel ACT-0002", "complete ACT-0003"). Extract entityId (the ACT-NNNN) and newStatus ("done", "cancelled", "in_progress"). "close" and "complete" map to "done".
- reassign_action: User wants to reassign an EXISTING action (ACT-NNNN) to someone else (e.g. "assign ACT-0001 to Mark", "ACT-0002 reassign to Sarah", "give ACT-0003 to John"). Extract entityId (the ACT-NNNN) and newAssignee (the person's name or @mention).
- create_reminder: User wants a reminder at a future time (e.g. "remind me at 3pm to call John", "reminder in 2 hours check the build")
- store_knowledge: User wants to store/remember/note a fact (e.g. "remember that Schwarz have 10k users", "note: rate limit is 100/min", "remember this", "store that")
- retrieve_knowledge: User is asking a question that may be answered from team knowledge stored by the bot — facts, procedures, contacts, configurations, past decisions (e.g. "what is our rate limit?", "how do we handle auth?", "who is the Schwarz contact?", "what's the onboarding process?"). Prefer this over general_question for any information-seeking question. Do NOT use for statements, answers, or confirmations — "Yes we did", "We decided X", "The meeting is on Friday" are NOT retrieve_knowledge.
- list_my_tasks: User wants to see their own tasks (e.g. "my tasks", "what am I working on?", "show my tasks")
- list_decisions: User wants to see or search decisions (e.g. "list decisions", "what decisions were made about migration?", "decisions about pricing")
- list_my_actions: User wants to see their own actions (e.g. "my actions", "what do I need to do?", "show actions")
- list_team_actions: User wants to see all team actions (e.g. "team actions", "what is the team working on?", "show all actions")
- list_reminders: User wants to see their pending reminders (e.g. "show reminders", "my reminders", "list reminders", "what reminders do I have?")
- help: User is asking what the bot does or how to use it (e.g. "what can you do?", "help", "how do I use this?", "what are you?")
- secret_mode_on: User wants the bot to stop listening (e.g. "secret mode", "go quiet", "stop listening", "this is sensitive", "private conversation", "pause")
- secret_mode_off: User wants the bot to resume (e.g. "resume", "come back", "you can listen again", "start listening", "unpause")
- general_question: User is asking a general question unlikely to be in the team knowledge base — about the bot itself, current time, summaries of the current discussion, or open-ended questions not fitting any other intent (e.g. "what can you do?", "can you summarise the discussion?", "what time is it?"). For team knowledge questions, prefer retrieve_knowledge.
- none: General conversation not directed at the bot — reactions, acknowledgements, chit-chat, statements

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

SHOULD RESPOND rules:
- true: ONLY when the message is an explicit command directed at the bot — clear bot syntax like "TASK-0001 done", "list my tasks", "remind me at 3pm", "help", "secret mode", "remember that X", "forget KB-0001". The message must be unambiguously intended for the bot.
- false: for everything else, including general questions between humans, statements, decisions, or actions overheard in conversation — even if an intent is detected. Passive capture (capture field) happens silently without the bot responding. general_question is always false here; @mention handling is done separately by the caller.

CAPTURE rules (passive recording of information from the conversation):
Sensitivity levels:
- strict: only clear, explicitly stated facts/decisions
- normal: factual statements + procedural knowledge
- aggressive: also soft commitments and implied decisions

NEVER capture:
- Bot commands ("show reminders", "list tasks", "what can you do")
- Questions, acknowledgements, chit-chat
- Bot responses
Only capture substantive information: facts, decisions made, commitments, planned actions.

Omit the "capture" field entirely when there is nothing to capture. When capturing, include at most one candidate (the most valuable one).

Return only valid JSON, no markdown:
{"intent":"<intent>","confidence":<0.0-1.0>,"payload":{<fields>},"shouldRespond":<true|false>}

Or with capture:
{"intent":"<intent>","confidence":<0.0-1.0>,"payload":{<fields>},"shouldRespond":<true|false>,"capture":{"type":"<task|decision|action|knowledge>","confidence":<0.0-1.0>,"summary":"<short string>","detail":"<longer description>","payload":{<fields>}}}`;

const VALID_INTENTS: IntentType[] = [
  "create_task",
  "update_task_status",
  "create_decision",
  "create_action",
  "update_action_status",
  "reassign_action",
  "create_reminder",
  "store_knowledge",
  "retrieve_knowledge",
  "list_my_tasks",
  "list_decisions",
  "list_my_actions",
  "list_team_actions",
  "list_reminders",
  "help",
  "secret_mode_on",
  "secret_mode_off",
  "general_question",
  "none",
];

const FALLBACK: ConversationIntelligenceResult = {
  intent: "none",
  payload: {},
  confidence: 0,
  shouldRespond: false,
};

export class OpenAIConversationIntelligenceAdapter implements ConversationIntelligenceService {
  constructor(private readonly config: LLMConfig, private readonly logger: Logger) {}

  async analyze(input: ConversationIntelligenceInput): Promise<ConversationIntelligenceResult> {
    if (!this.config.enabled) {
      return { intent: "none", payload: {}, confidence: 1.0, shouldRespond: false };
    }

    this.logger.debug("Intelligence analysis called", {
      text: input.currentMessage.slice(0, 80),
      conversationId: input.conversationId.id,
      sensitivity: input.sensitivity,
    });

    const recentLines = input.recentMessages
      .map((m) => `[${m.senderId.id}]: ${m.text}`)
      .join("\n");

    const userContent = [
      input.previousMessageText
        ? `Previous message (for context): "${input.previousMessageText}"`
        : null,
      `Current message: "${input.currentMessage}"`,
      "",
      "Recent conversation (last messages):",
      recentLines || "(none)",
      "",
      `Sensitivity: ${input.sensitivity}`,
    ]
      .filter((line) => line !== null)
      .join("\n");

    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      max_tokens: 150,
      temperature: 0,
      // Disable Qwen3/Ollama chain-of-thought "thinking" mode — not needed for
      // intent classification and adds significant latency on CPU-only inference.
      think: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.logger.warn("Conversation intelligence — LLM request timed out after 30s");
        return FALLBACK;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Conversation intelligence LLM request failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return FALLBACK;

    let parsed: {
      intent?: string;
      confidence?: number;
      payload?: IntentPayload;
      shouldRespond?: boolean;
      capture?: {
        type?: string;
        confidence?: number;
        summary?: string;
        detail?: string;
        payload?: Record<string, unknown>;
      };
    };

    try {
      parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, "").trim()) as typeof parsed;
    } catch {
      this.logger.warn("Conversation intelligence — failed to parse LLM response", {
        preview: content.slice(0, 200),
      });
      return FALLBACK;
    }

    const intent = parsed.intent as IntentType | undefined;
    if (!intent || !VALID_INTENTS.includes(intent)) {
      return FALLBACK;
    }

    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0)));
    const shouldRespond = Boolean(parsed.shouldRespond ?? false);

    let capture: CaptureCandidate | undefined;
    if (parsed.capture && typeof parsed.capture === "object") {
      const c = parsed.capture;
      const captureType = c.type;
      if (
        captureType === "task" ||
        captureType === "decision" ||
        captureType === "action" ||
        captureType === "knowledge"
      ) {
        const captureConfidence = Math.min(1, Math.max(0, Number(c.confidence ?? 0)));
        capture = {
          type: captureType,
          confidence: captureConfidence,
          summary: typeof c.summary === "string" ? c.summary : "",
          detail: typeof c.detail === "string" ? c.detail : "",
          payload:
            typeof c.payload === "object" && c.payload !== null
              ? (c.payload as Record<string, unknown>)
              : {},
        };
      }
    }

    const result: ConversationIntelligenceResult = {
      intent,
      confidence,
      payload: parsed.payload ?? {},
      shouldRespond,
      ...(capture !== undefined ? { capture } : {}),
    };

    this.logger.debug("Intelligence result", {
      intent: result.intent,
      confidence: result.confidence,
      shouldRespond: result.shouldRespond,
      hasCapture: capture !== undefined,
    });

    return result;
  }
}
