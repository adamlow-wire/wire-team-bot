import type {
  AuditLogRepository,
  AuditLogEntry,
} from "../../../domain/repositories/AuditLogRepository";
import { getPrismaClient } from "./PrismaClient";

export class PrismaAuditLogRepository implements AuditLogRepository {
  private prisma = getPrismaClient();

  async append(entry: AuditLogEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        ...(entry.id != null ? { id: entry.id } : {}),
        timestamp: entry.timestamp,
        actorId: entry.actorId.id,
        actorDom: entry.actorId.domain,
        conversationId: entry.conversationId?.id ?? null,
        conversationDom: entry.conversationId?.domain ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        details: entry.details as object | null ?? undefined,
      },
    });
  }
}
