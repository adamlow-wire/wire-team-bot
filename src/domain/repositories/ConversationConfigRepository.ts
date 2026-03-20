import type { QualifiedId } from "../ids/QualifiedId";

export type ImplicitSensitivity = "strict" | "normal" | "aggressive";

export interface ConversationConfig {
  conversationId: QualifiedId;
  timezone: string;
  locale: string;
  /** When true (default), implicit intent detection runs when no explicit trigger matches. */
  implicitDetectionEnabled?: boolean;
  /** Sensitivity for implicit detection: strict (fewer prompts), normal, aggressive. */
  sensitivity?: ImplicitSensitivity;
  /** When true the bot is in secret mode: it does not process or record anything. */
  secretMode?: boolean;
  /** What this channel/conversation is used for — injected into every LLM prompt. */
  purpose?: string;
  // Raw JSON blob matching section 9 config, kept flexible in domain.
  raw: unknown;
}

export interface ConversationConfigRepository {
  get(conversationId: QualifiedId): Promise<ConversationConfig | null>;
  upsert(config: ConversationConfig): Promise<ConversationConfig>;
}

