import type {
  ImplicitDetectionService,
  ImplicitDetectionInput,
  ImplicitCandidate,
} from "../../domain/services/ImplicitDetectionService";
import type { LLMConfig } from "./LLMConfigAdapter";
import type { Logger } from "../../application/ports/Logger";

const MIN_CONFIDENCE = 0.5;

function buildPrompt(input: ImplicitDetectionInput): string {
  const lines = input.recentMessages.map(
    (m) => `[${m.senderId.id}]: ${m.text}`,
  );
  const transcript = lines.join("\n");
  return `You are a meeting assistant. Given the last messages in a conversation, detect if someone just stated a fact, decision, task, or action worth recording.

Sensitivity: ${input.sensitivity}. Strict = only clear factual statements. Normal = factual + procedural. Aggressive = also soft commitments.

IMPORTANT — do NOT capture any of the following:
- Commands or requests directed at the bot (e.g. "show reminders", "list tasks", "what can you do", "remind me", "remember this")
- Questions asked by a user seeking information
- Acknowledgements, reactions, or chit-chat (e.g. "ok", "thanks", "sounds good", "yes", "no")
- Bot responses or confirmations
- Meta-conversation about what the user wants the bot to do

Only capture substantive information FROM the conversation: facts, decisions made, commitments, or planned actions.

Recent messages:
---
${transcript}
---

If there is nothing to capture, return: {"candidates":[]}
Otherwise return a JSON object with key "candidates", an array of objects. Each object: "type" (one of: "task", "decision", "action", "knowledge"), "confidence" (0-1 number), "summary" (short string), "payload" (object with fields useful for that type, e.g. for knowledge: {"summary":"...","detail":"..."}).

Only include candidates with confidence >= ${MIN_CONFIDENCE}. Return only valid JSON, no markdown.`;
}

export class OpenAIImplicitDetectionAdapter implements ImplicitDetectionService {
  constructor(private readonly config: LLMConfig, private readonly logger: Logger) {}

  async detect(input: ImplicitDetectionInput): Promise<ImplicitCandidate[]> {
    if (!this.config.enabled || !this.config.apiKey) return [];

    this.logger.debug("Implicit detection triggered", {
      conversationId: input.conversationId.id,
      messageCount: input.recentMessages.length,
      model: this.config.model,
      sensitivity: input.sensitivity,
    });

    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.config.model,
      messages: [
        { role: "system", content: "You output only valid JSON." },
        { role: "user", content: buildPrompt(input) },
      ],
      max_tokens: 600,
      temperature: 0.2,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LLM request failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") return [];

    let parsed: { candidates?: unknown[] };
    try {
      const cleaned = content.replace(/^```json\s*|\s*```$/g, "").trim();
      parsed = JSON.parse(cleaned) as { candidates?: unknown[] };
    } catch {
      this.logger.warn("Implicit detection — failed to parse LLM response", { preview: content.slice(0, 200) });
      return [];
    }

    const candidates = parsed.candidates;
    if (!Array.isArray(candidates)) return [];

    const out: ImplicitCandidate[] = [];
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const obj = c as Record<string, unknown>;
      const type = obj.type as string;
      if (!["task", "decision", "action", "knowledge"].includes(type)) continue;
      const confidence = Number(obj.confidence);
      if (Number.isNaN(confidence) || confidence < MIN_CONFIDENCE) continue;
      const summary = typeof obj.summary === "string" ? obj.summary : "";
      const payload = typeof obj.payload === "object" && obj.payload !== null
        ? (obj.payload as Record<string, unknown>)
        : {};
      out.push({
        type: type as ImplicitCandidate["type"],
        confidence,
        summary,
        payload,
      });
    }

    this.logger.debug("Implicit detection candidates", {
      conversationId: input.conversationId.id,
      count: out.length,
      candidates: out.map((c) => ({ type: c.type, confidence: c.confidence })),
    });

    return out;
  }
}
