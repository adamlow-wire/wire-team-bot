/**
 * LLM-as-judge for E2E test evaluation.
 *
 * Sends the bot's response and a plain-English assertion to the configured
 * LLM endpoint and gets back a PASS/FAIL verdict with a one-line reason.
 *
 * Uses the same JEEVES_LLM_BASE_URL / JEEVES_LLM_API_KEY env vars as the bot.
 * Model is controlled by JEEVES_JUDGE_MODEL (defaults to JEEVES_MODEL_CLASSIFY).
 */

import path from "path";
import { config as loadDotenv } from "dotenv";

// Load .env from repo root so JEEVES_* vars are available when running via tsx
loadDotenv({ path: path.resolve(__dirname, "../../.env") });

export interface JudgeResult {
  pass: boolean;
  valid: boolean;
  invalidAttempts?: string[];
  reason: string;
  raw: string;
}

const SYSTEM_PROMPT = `You are a test evaluator for a team assistant bot called Wire Team Bot (legacy test assertions may call it Jeeves).
You will be given a bot response and an assertion describing what a correct response should contain or do.
Evaluate whether the bot response satisfies the assertion. The assertion defines the required behaviour: when it gives an exact date, compare the response against that date rather than substituting your own interpretation.
Date policy: a date-only weekday matching the scenario's local calendar day means that same day, including after its default noon time. "Next Friday" means the following Friday. Do not move "this Friday" to next week merely because the reference day is Friday. Use the supplied conversation timezone for the reference calendar day.
Recorder and decision maker are distinct roles. A requirement to identify the recorder does not require claiming that they made the decision.
Reply with exactly one line in this format: PASS: <brief reason> or FAIL: <brief reason>
Keep reasons under 15 words. Be strict but fair.`.trim();

export interface EvaluationContext { referenceTime: string; timezone: string }

async function judgeOnce(botResponse: string, assertion: string,
  context: EvaluationContext = { referenceTime: new Date().toISOString(), timezone: "UTC" },
): Promise<JudgeResult> {
  const baseUrl = process.env.JEEVES_LLM_BASE_URL;
  const apiKey  = process.env.JEEVES_LLM_API_KEY ?? "none";
  const model   = process.env.JEEVES_JUDGE_MODEL
               ?? process.env.JEEVES_MODEL_CLASSIFY
               ?? "qwen3-2507:4b";

  if (!baseUrl) {
    throw new Error("JEEVES_LLM_BASE_URL is not set — cannot run judge");
  }

  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Scenario reference time (UTC): ${context.referenceTime}\nConversation timezone: ${context.timezone}\nUse this scenario time and timezone, not the wall clock when this evaluation runs.\n\nBot response:\n${botResponse}\n\nAssertion: ${assertion}`,
      },
    ],
    max_tokens: 150,
    temperature: 0 as number | undefined,
  };

  // Retry once on transient network/server errors
  let res: Response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    if (res.ok) break;
    // Match the runtime client's bounded compatibility path. Never log the
    // provider body, which can echo inputs; never retry unrelated 400s.
    if (res.status === 400 && attempt === 0) {
      const error = await res.json().catch(() => null) as { error?: { message?: unknown } } | null;
      const message = error?.error?.message;
      if (typeof message === "string" && /temperature/i.test(message)
        && /deprecated|unsupported|not supported/i.test(message)) {
        body.temperature = undefined;
        continue;
      }
    }
    if (res.status < 500 || attempt === 1) throw new Error(`Judge LLM request failed: HTTP ${res.status}`);
    await new Promise(r => setTimeout(r, 1500));
  }

  const json = await res!.json() as { choices: Array<{ message: { content: string } }> };
  const raw = json.choices[0]?.message?.content?.trim() ?? "";

  // Strip <think>...</think> blocks (qwen3 thinking mode)
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const verdict = /^(PASS|FAIL)\s*[:–-]\s*([^\r\n]+)$/i.exec(cleaned);
  return { pass: verdict?.[1].toUpperCase() === "PASS", valid: verdict !== null,
    reason: verdict ? verdict[2].trim() : "Invalid judge verdict format", raw: cleaned };
}

/** Retry only malformed protocol, never a valid FAIL. Preserve the malformed output. */
export async function judge(botResponse: string, assertion: string,
  context: EvaluationContext = { referenceTime: new Date().toISOString(), timezone: "UTC" },
): Promise<JudgeResult> {
  const first = await judgeOnce(botResponse, assertion, context);
  if (first.valid) return first;
  const second = await judgeOnce(botResponse, assertion, context);
  return { ...second, invalidAttempts: [first.raw, ...(second.valid ? [] : [second.raw])] };
}
