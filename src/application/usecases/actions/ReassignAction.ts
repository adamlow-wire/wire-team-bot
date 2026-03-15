import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { UserResolutionService } from "../../../domain/services/UserResolutionService";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface ReassignActionInput {
  actionId: string;
  conversationId: QualifiedId;
  newAssigneeReference: string;
  actorId: QualifiedId;
  replyToMessageId?: string;
}

export class ReassignAction {
  constructor(
    private readonly actions: ActionRepository,
    private readonly userResolution: UserResolutionService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: ReassignActionInput): Promise<Action | null> {
    const action = await this.actions.findById(input.actionId);
    if (!action || action.conversationId.id !== input.conversationId.id) {
      return null;
    }

    const resolved = await this.userResolution.resolveByHandleOrName(
      input.newAssigneeReference,
      { conversationId: input.conversationId },
    );

    if (!resolved.userId || resolved.ambiguous) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        resolved.ambiguous
          ? "Multiple users match; please use @mention."
          : "Could not resolve assignee.",
        { replyToMessageId: input.replyToMessageId },
      );
      return null;
    }

    const previousAssigneeName = action.assigneeName;
    const updated: Action = {
      ...action,
      assigneeId: resolved.userId,
      assigneeName: input.newAssigneeReference,
      updatedAt: new Date(),
      version: action.version + 1,
    };

    await this.actions.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Action",
      entityId: action.id,
      details: { reassignedTo: input.newAssigneeReference },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `${action.id} reassigned from ${previousAssigneeName} to ${input.newAssigneeReference}.`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
