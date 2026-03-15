import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export type ActionStatusUpdate = "open" | "in_progress" | "done" | "cancelled" | "overdue";

export interface UpdateActionStatusInput {
  actionId: string;
  newStatus: ActionStatusUpdate;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  completionNote?: string;
  replyToMessageId?: string;
}

export class UpdateActionStatus {
  constructor(
    private readonly actions: ActionRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: UpdateActionStatusInput): Promise<Action | null> {
    const action = await this.actions.findById(input.actionId);
    if (!action || action.conversationId.id !== input.conversationId.id) return null;

    const updated: Action = {
      ...action,
      status: input.newStatus,
      updatedAt: new Date(),
      version: action.version + 1,
      completionNote: input.newStatus === "done" ? (input.completionNote ?? null) : action.completionNote,
    };

    await this.actions.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Action",
      entityId: updated.id,
      details: { newStatus: input.newStatus },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `${updated.id} marked as ${input.newStatus}.`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
