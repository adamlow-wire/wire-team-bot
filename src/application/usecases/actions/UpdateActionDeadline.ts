import type { Action } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { DateTimeService } from "../../../domain/services/DateTimeService";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface UpdateActionDeadlineInput {
  actionId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  deadlineText: string;
  timezone: string;
  replyToMessageId?: string;
}

export class UpdateActionDeadline {
  constructor(
    private readonly actions: ActionRepository,
    private readonly dateTimeService: DateTimeService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: UpdateActionDeadlineInput): Promise<Action | null> {
    const action = await this.actions.findById(input.actionId);
    if (!action || action.conversationId.id !== input.conversationId.id) {
      return null;
    }

    const parsed = this.dateTimeService.parse(input.deadlineText, {
      timezone: input.timezone,
    });

    if (!parsed) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        `Could not parse date/time: "${input.deadlineText}". Please try again with a clearer expression.`,
        { replyToMessageId: input.replyToMessageId },
      );
      return null;
    }

    const newDeadline = parsed.value;
    const updated: Action = {
      ...action,
      deadline: newDeadline,
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
      details: { deadline: newDeadline },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${action.id}** deadline set to **${newDeadline.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}**.`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
