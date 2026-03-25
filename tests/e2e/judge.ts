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
  reason: string;
  raw: string;
}

const SYSTEM_PROMPT = `You are a test evaluator for a team assistant bot called Jeeves.
You will be given a bot response and an assertion describing what a correct response should contain or do.
Evaluate whether the bot response satisfies the assertion.
Reply with exactly one line in this format: PASS: <brief reason> or FAIL: <brief reason>
Keep reasons under 15 words. Be strict but fair.`.trim();

export async function judge(botResponse: string, assertion: string): Promise<JudgeResult> {
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
        content: `Bot response:\n${botResponse}\n\nAssertion: ${assertion}`,
      },
    ],
    max_tokens: 80,
    temperature: 0,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Judge LLM request failed: HTTP ${res.status}`);
  }

  const json = await res.json() as { choices: Array<{ message: { content: string } }> };
  const raw = json.choices[0]?.message?.content?.trim() ?? "";

  // Strip <think>...</think> blocks (qwen3 thinking mode)
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const pass = /^PASS/i.test(cleaned);
  const reason = cleaned.replace(/^(PASS|FAIL)\s*[:–\-]?\s*/i, "").trim();

  return { pass, reason, raw: cleaned };
}
