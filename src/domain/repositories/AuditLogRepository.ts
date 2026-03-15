import type { QualifiedId } from "../ids/QualifiedId";

export type AuditAction =
  | "entity_created"
  | "entity_updated"
  | "entity_deleted"
  | "config_changed"
  | "export_triggered";

export interface AuditLogEntry {
  /** Optional; adapter may omit so persistence layer generates (e.g. cuid). */
  id?: string;
  timestamp: Date;
  actorId: QualifiedId;
  conversationId?: QualifiedId | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  details?: unknown;
}

export interface AuditLogRepository {
  append(entry: AuditLogEntry): Promise<void>;
}

