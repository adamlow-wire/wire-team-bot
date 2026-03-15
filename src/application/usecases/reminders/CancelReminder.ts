import type { Reminder } from "../../../domain/entities/Reminder";
import type { ReminderRepository } from "../../../domain/repositories/ReminderRepository";
import type { SchedulerPort } from "../../ports/SchedulerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface CancelReminderInput {
  reminderId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  replyToMessageId?: string;
}

export class CancelReminder {
  constructor(
    private readonly reminders: ReminderRepository,
    private readonly scheduler: SchedulerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: CancelReminderInput): Promise<Reminder | null> {
    const reminder = await this.reminders.findById(input.reminderId);
    if (
      !reminder ||
      !reminder.conversationId ||
      reminder.conversationId.id !== input.conversationId.id
    ) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        "Reminder not found.",
        { replyToMessageId: input.replyToMessageId },
      );
      return null;
    }

    if (reminder.status !== "pending") {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        `That reminder has already been \`${reminder.status}\`.`,
        { replyToMessageId: input.replyToMessageId },
      );
      return null;
    }

    const updated: Reminder = {
      ...reminder,
      status: "cancelled",
      updatedAt: new Date(),
      version: reminder.version + 1,
    };

    await this.reminders.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Reminder",
      entityId: reminder.id,
      details: { status: "cancelled" },
    });

    this.scheduler.cancel(`rem-${reminder.id}`);

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${reminder.id}** cancelled.`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
