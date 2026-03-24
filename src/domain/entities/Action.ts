import type { QualifiedId } from "../ids/QualifiedId";

export type ActionStatus = "open" | "in_progress" | "done" | "cancelled" | "overdue";

export interface ActionSourceRef {
  wire_msg_ids: string[];
  timestamp_range: { start: string; end: string };
}

export interface Action {
  id: string;
  description: string;
  rawMessageId: string;
  assigneeId: QualifiedId;
  assigneeName: string;
  creatorId: QualifiedId;
  authorName: string;
  conversationId: QualifiedId;
  deadline: Date | null;
  status: ActionStatus;
  linkedIds: string[];
  reminderAt: Date[]; // scheduled reminder timestamps
  completionNote: string | null;
  timestamp: Date;
  updatedAt: Date;
  tags: string[];
  deleted: boolean;
  version: number;
  // Phase 1a / Phase 2 additions
  /** When this action becomes stale if not updated (set by pipeline based on deadline). */
  stalenessAt?: Date | null;
  /** Last time a staleness check was performed. */
  lastStatusCheck?: Date | null;
  /** LLM extraction confidence (0–1). Absent for manually-created actions. */
  actionConfidence?: number;
  /** ID of a related decision that triggered this action, if applicable. */
  relatedDecisionId?: string | null;
  /** Wire message reference — replaces verbatim rawMessage content. */
  sourceRef?: ActionSourceRef;
  /** Wire domain used as organisation scope. */
  organisationId?: string;
}
