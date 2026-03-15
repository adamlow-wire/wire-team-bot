import type { Reminder } from "../../../domain/entities/Reminder";
import type { ReminderRepository } from "../../../domain/repositories/ReminderRepository";
import type { DateTimeService } from "../../../domain/services/DateTimeService";
import type { SchedulerPort } from "../../ports/SchedulerPort";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface SnoozeReminderInput {
  reminderId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  snoozeExpression: string;
  timezone: string;
  replyToMessageId?: string;
}

export class SnoozeReminder {
  constructor(
    private readonly reminders: ReminderRepository,
    private readonly dateTimeService: DateTimeService,
    private readonly scheduler: SchedulerPort,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: SnoozeReminderInput): Promise<Reminder | null> {
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

    const parsed = this.dateTimeService.parse(input.snoozeExpression, {
      timezone: input.timezone,
    });

    if (!parsed) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        `Could not parse date/time: "${input.snoozeExpression}". Please try again with a clearer expression.`,
        { replyToMessageId: input.replyToMessageId },
      );
      return null;
    }

    const newDate = parsed.value;

    this.scheduler.cancel(`rem-${reminder.id}`);

    const updated: Reminder = {
      ...reminder,
      triggerAt: newDate,
      updatedAt: new Date(),
      version: reminder.version + 1,
    };

    await this.reminders.update(updated);

    this.scheduler.schedule({
      id: `rem-${reminder.id}`,
      type: "reminder",
      runAt: newDate,
      payload: { reminderId: reminder.id },
    });

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Reminder",
      entityId: reminder.id,
      details: { snoozedUntil: newDate },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `**${reminder.id}** snoozed until **${newDate.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}**.`,
      { replyToMessageId: input.replyToMessageId },
    );

    return updated;
  }
}
