import type { QualifiedId } from "../ids/QualifiedId";

export type DecisionStatus = "active" | "superseded" | "revoked";

export interface DecisionContextItem {
  userId: QualifiedId;
  userName: string;
  messageText: string;
  messageId: string;
  timestamp: Date;
}

export interface DecisionAttachment {
  assetId: string;
  filename: string;
  mimeType: string;
}

export interface DecisionSourceRef {
  /** Wire message IDs the decision was extracted from. */
  wire_msg_ids: string[];
  timestamp_range: { start: string; end: string };
}

export interface Decision {
  id: string;
  summary: string;
  rawMessageId: string;
  context: DecisionContextItem[];
  authorId: QualifiedId;
  authorName: string;
  participants: QualifiedId[];
  conversationId: QualifiedId;
  status: DecisionStatus;
  supersededBy?: string | null;
  supersedes?: string | null;
  linkedIds: string[];
  attachments: DecisionAttachment[];
  tags: string[];
  timestamp: Date;
  updatedAt: Date;
  deleted: boolean;
  version: number;
  // Phase 1a / Phase 2 additions
  /** When the decision was crystallised (defaults to timestamp if not set). */
  decidedAt?: Date;
  /** Why this decision was made, synthesised by the extractor. */
  rationale?: string;
  /** Names/IDs of participants who made the decision. */
  decidedBy?: string[];
  /** LLM extraction confidence (0–1). Absent for manually-created decisions. */
  confidence?: number;
  /** Model name used for extraction, if extracted by the pipeline. */
  extractionModel?: string;
  /** Wire message reference — replaces verbatim rawMessage content. */
  sourceRef?: DecisionSourceRef;
  /** Wire domain used as organisation scope. */
  organisationId?: string;
  /** Provenance: 'seed' | 'extraction' | 'tool_call' | 'file:<filename>' */
  source?: string;
  /** True for standing records immune to contradiction detection and auto-expiry. */
  standing?: boolean;
  /** Admin note on standing records (e.g. 'removed_from_seed'). */
  sourceNote?: string;
}
