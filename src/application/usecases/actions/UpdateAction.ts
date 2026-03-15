import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { ActionStatus } from "../../../domain/entities/Action";
import type { ActionRepository } from "../../../domain/repositories/ActionRepository";
import type { ConversationConfigRepository } from "../../../domain/repositories/ConversationConfigRepository";
import type { DateTimeService } from "../../../domain/services/DateTimeService";
import type { UserResolutionService } from "../../../domain/services/UserResolutionService";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";

export interface UpdateActionInput {
  actionId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  replyToMessageId?: string;
  newStatus?: ActionStatus;
  newAssigneeReference?: string;
  newDeadlineText?: string;
}

export class UpdateAction {
  constructor(
    private readonly actions: ActionRepository,
    private readonly conversationConfig: ConversationConfigRepository,
    private readonly dateTimeService: DateTimeService,
    private readonly userResolution: UserResolutionService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: UpdateActionInput): Promise<void> {
    const action = await this.actions.findById(input.actionId);
    if (!action || action.conversationId.id !== input.conversationId.id) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        `Action \`${input.actionId}\` not found in this conversation.`,
        { replyToMessageId: input.replyToMessageId },
      );
      return;
    }

    const now = new Date();
    const changes: string[] = [];
    let updated = { ...action, updatedAt: now, version: action.version + 1 };

    if (input.newStatus) {
      updated = { ...updated, status: input.newStatus };
      changes.push(`status → \`${input.newStatus}\``);
    }

    if (input.newAssigneeReference) {
      const resolved = await this.userResolution.resolveByHandleOrName(input.newAssigneeReference, {
        conversationId: input.conversationId,
      });
      if (!resolved.userId || resolved.ambiguous) {
        await this.wireOutbound.sendPlainText(
          input.conversationId,
          resolved.ambiguous ? "Multiple users match; please use @mention." : "Could not resolve assignee.",
          { replyToMessageId: input.replyToMessageId },
        );
        return;
      }
      const oldName = updated.assigneeName;
      updated = { ...updated, assigneeId: resolved.userId, assigneeName: input.newAssigneeReference };
      changes.push(`assignee: **${oldName}** → **${input.newAssigneeReference}**`);
    }

    if (input.newDeadlineText) {
      const config = await this.conversationConfig.get(input.conversationId);
      const timezone = config?.timezone ?? "UTC";
      const parsed = this.dateTimeService.parse(input.newDeadlineText, { timezone });
      if (!parsed?.value) {
        await this.wireOutbound.sendPlainText(
          input.conversationId,
          `Sorry, I couldn't parse "${input.newDeadlineText}" as a date.`,
          { replyToMessageId: input.replyToMessageId },
        );
        return;
      }
      updated = { ...updated, deadline: parsed.value };
      changes.push(`deadline → _${parsed.value.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}_`);
    }

    if (changes.length === 0) return;

    await this.actions.update(updated);
    await this.auditLog.append({
      timestamp: now,
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Action",
      entityId: action.id,
      details: { changes },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${action.id}** updated: ${changes.join(", ")}.`,
      { replyToMessageId: input.replyToMessageId },
    );
  }
}
