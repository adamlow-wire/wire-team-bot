import type { IntentType, IntentPayload } from "./IntentClassifierService";

export interface CaptureCandidate {
  type: "task" | "decision" | "action" | "knowledge";
  confidence: number;
  summary: string;
  detail: string;
  payload: Record<string, unknown>;
}

export interface ConversationIntelligenceResult {
  intent: IntentType;
  confidence: number;
  payload: IntentPayload;
  shouldRespond: boolean; // true if the bot should act/reply on this message
  capture?: CaptureCandidate; // present only when there is a passive capture candidate
}

export interface ConversationIntelligenceInput {
  currentMessage: string;
  currentMessageId: string;
  previousMessageText?: string;
  recentMessages: { senderId: { id: string; domain: string }; text: string; messageId: string }[];
  sensitivity: "strict" | "normal" | "aggressive";
  conversationId: { id: string; domain: string };
}

export interface ConversationIntelligenceService {
  analyze(input: ConversationIntelligenceInput): Promise<ConversationIntelligenceResult>;
}
