import type {
  ConversationIntelligenceService,
  ConversationIntelligenceInput,
  ConversationIntelligenceResult,
  CaptureCandidate,
} from "../../domain/services/ConversationIntelligenceService";
import type { IntentType, IntentPayload } from "../../domain/services/IntentClassifierService";
import type { LLMConfig } from "./LLMConfigAdapter";
import type { Logger } from "../../application/ports/Logger";

const SYSTEM_PROMPT = `You are the conversation intelligence layer for Jeeves, a discreet British team assistant embedded in Wire. Your sole job is to classify intent, detect capture candidates, and decide whether to respond — quickly and accurately.

INTENTS:
- create_task: User wants to create/add a new task or to-do item (e.g. "we need to write the spec", "task: build the API")
- update_task_status: User wants to change the status of an EXISTING task identified by a TASK-NNNN ID (e.g. "close TASK-0001", "done TASK-0002", "mark TASK-0003 as complete", "TASK-0001 done", "cancel TASK-0002"). Extract entityId (the TASK-NNNN) and newStatus ("done", "cancelled", "in_progress").
- create_decision: User wants to record a decision that was made (e.g. "we've decided to use Postgres", "decision: go with option A")
- create_action: User wants to create a NEW action item — something a specific person must do (e.g. "John should follow up on the contract", "action: Emil to review the PR"). Do NOT use this if a TASK/ACT/DEC ID is mentioned.
- update_action_status: User wants to change the status of an EXISTING action identified by an ACT-NNNN ID (e.g. "close ACT-0001", "done ACT-0002", "mark ACT-0003 as complete", "ACT-0001 done", "cancel ACT-0002", "complete ACT-0003"). Extract entityId (the ACT-NNNN) and newStatus ("done", "cancelled", "in_progress"). "close" and "complete" map to "done".
- reassign_action: User wants to reassign an EXISTING action (ACT-NNNN) to someone else (e.g. "assign ACT-0001 to Mark", "ACT-0002 reassign to Sarah", "give ACT-0003 to John"). Extract entityId (the ACT-NNNN) and newAssignee (the person's name or @mention).
- create_reminder: User wants a reminder at a future time (e.g. "remind me at 3pm to call John", "reminder in 2 hours check the build")
- store_knowledge: User explicitly wants to store/remember/note a fact (e.g. "remember that Schwarz have 10k users", "note: rate limit is 100/min", "remember this", "store that"). Only for explicit store commands — NOT for answering questions.
- retrieve_knowledge: User is asking a question that may be answered from team knowledge stored by the bot — facts, procedures, contacts, configurations, past decisions (e.g. "what is our rate limit?", "how do we handle auth?", "who is the Schwarz contact?"). Prefer this over general_question for any information-seeking question. Do NOT use for statements, answers, or confirmations.
- list_my_tasks: User wants to see their own tasks (e.g. "my tasks", "what am I working on?", "show my tasks")
- list_decisions: User wants to see or search decisions (e.g. "list decisions", "what decisions were made about migration?", "decisions about pricing")
- list_my_actions: User wants to see their own actions (e.g. "my actions", "what do I need to do?", "show actions")
- list_team_actions: User wants to see all team actions (e.g. "team actions", "what is the team working on?", "show all actions", "what does [person] need to do?")
- list_reminders: User wants to see their pending reminders (e.g. "show reminders", "my reminders", "list reminders")
- help: User is asking what the bot does, how to use it, or who/what it is (e.g. "what can you do?", "help", "how do I use this?", "what are you?", "who are you?", "do you know X?", "can you X?")
- secret_mode_on: User wants the bot to stop listening (e.g. "secret mode", "go quiet", "stop listening", "private conversation", "pause")
- secret_mode_off: User wants the bot to resume (e.g. "resume", "come back", "you can listen again", "start listening", "unpause")
- general_question: User is asking a general question about the current discussion, time, context, or anything not fitting another intent. For team knowledge questions, prefer retrieve_knowledge.
- none: General conversation not directed at the bot — reactions, acknowledgements, chit-chat, statements, answers

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
- false: for everything else, including general questions between humans, statements, decisions, or actions overheard in conversation — even if an intent is detected. Passive capture (capture field) happens silently. general_question is always false here; @mention handling is done separately by the caller.

CAPTURE rules (passive recording of information from the conversation):
Sensitivity levels:
- strict: only clear, explicitly stated facts/decisions
- normal: factual statements + procedural knowledge
- aggressive: also soft commitments and implied decisions

NEVER capture — omit "capture" entirely for:
- QUESTIONS of any kind. Any message asking for information, seeking confirmation, or requesting something is NOT a fact and must NOT be captured.
  This includes messages containing: ?, "how many", "what is", "what are", "who is", "where is", "when is", "can you", "could you", "do you", "does", "is there", "are there", "have you", "did you", "tell me", "show me", "can we", "shall we", "should we", "would you", "do we", "is it", "is this"
  WRONG: "How many staff members are there at Wire?" → do NOT capture
  WRONG: "Do you know Joshua?" → do NOT capture
  WRONG: "We need to send a letter to the customer" if phrased as a general statement of need → use action capture instead
  CORRECT: "Wire has 300 staff members" → capture as knowledge
  CORRECT: "The rate limit is 100 requests per minute" → capture as knowledge
- Bot commands ("show reminders", "list tasks", "what can you do")
- Acknowledgements and chit-chat ("ok", "thanks", "sounds good", "got it")
- Bot responses or confirmations

Only capture STATEMENTS that assert facts, completed decisions, or specific commitments (actions).
For actions: only capture when there is a clear obligation or plan ("John will send the contract", "we need to call the client by Friday") — not vague intentions.

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

/**
 * Returns true when a message is clearly a question and should never be
 * treated as a capturable knowledge item. Catches explicit "?" endings and
 * the common English question openers that small models tend to misclassify.
 */
function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith("?")) return true;
  const lower = trimmed.toLowerCase();
  return /^(how|what|who|where|when|why|which|can you|can we|could you|do you|does|do we|is there|is it|is this|are there|have you|did you|tell me|show me|shall we|should we|would you)\b/.test(lower);
}

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

    const memberLine =
      input.members && input.members.length > 0
        ? `Conversation members: ${input.members.map((m) => m.name ? `${m.name} (${m.id})` : m.id).join(", ")}\n`
        : "";

    const purposeLine = input.conversationPurpose
      ? `Channel purpose: ${input.conversationPurpose}\n`
      : "";

    const userContent = [
      purposeLine + memberLine,
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
      max_tokens: 200,
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
        this.logger.warn("Conversation intelligence — LLM request timed out");
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

    // Hard guard: never treat a question as a capture candidate regardless of
    // what the LLM returned. Small models frequently ignore the prompt rule.
    if (capture !== undefined && isQuestion(input.currentMessage)) {
      this.logger.debug("Capture stripped — message is a question", { summary: capture.summary });
      capture = undefined;
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
