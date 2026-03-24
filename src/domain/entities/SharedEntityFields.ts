import type { QualifiedId } from "../ids/QualifiedId";

export type EntityStatus = string;

/**
 * Fields shared by all stored entities (tasks, decisions, actions, knowledge, reminders).
 * Mirrors section 2.1 of wire-bot-requirements.md.
 */
export interface SharedEntityFields {
  id: string; // e.g. TASK-0001
  conversationId: QualifiedId;
  authorId: QualifiedId;
  authorName: string;
  rawMessageId: string;
  timestamp: Date;
  updatedAt: Date;
  tags: string[];
  status: EntityStatus;
  deleted: boolean;
  version: number;
}

