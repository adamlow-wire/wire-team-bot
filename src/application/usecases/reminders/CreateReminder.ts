import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { Reminder } from "../../../domain/entities/Reminder";
import type { ReminderRepository } from "../../../domain/repositories/ReminderRepository";
import type { DateTimeService } from "../../../domain/services/DateTimeService";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { SchedulerPort, ScheduledJob } from "../../ports/SchedulerPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { Logger } from "../../ports/Logger";

export interface CreateReminderInput {
  conversationId: QualifiedId;
  authorId: QualifiedId;
  authorName: string;
  rawMessageId: string;
  description: string;
  targetId: QualifiedId;
  triggerAt: Date;
}

export class CreateReminder {
  constructor(
    private readonly reminders: ReminderRepository,
    private readonly dateTimeService: DateTimeService,
    private readonly wireOutbound: WireOutboundPort,
    private readonly scheduler: SchedulerPort,
    private readonly auditLog: AuditLogRepository,
    private readonly logger: Logger,
  ) {}

  async execute(input: CreateReminderInput): Promise<Reminder> {
    const now = new Date();
    const id = await this.reminders.nextId();

    const reminder: Reminder = {
      id,
      conversationId: input.conversationId,
      authorId: input.authorId,
      authorName: input.authorName,
      rawMessageId: input.rawMessageId,
      timestamp: now,
      updatedAt: now,
      tags: [],
      status: "pending",
      deleted: false,
      version: 1,
      description: input.description,
      targetId: input.targetId,
      triggerAt: input.triggerAt,
      recurrence: null,
      linkedIds: [],
      createdAt: now,
    };

    const saved = await this.reminders.create(reminder);
    this.logger.info("Reminder created", { reminderId: saved.id, conversationId: input.conversationId.id, triggerAt: saved.triggerAt.toISOString() });

    const job: ScheduledJob = {
      id: `rem-${saved.id}`,
      runAt: saved.triggerAt,
      type: "reminder",
      payload: { reminderId: saved.id },
    };
    this.scheduler.schedule(job);

    await this.auditLog.append({
      timestamp: now,
      actorId: input.authorId,
      conversationId: input.conversationId,
      action: "entity_created",
      entityType: "Reminder",
      entityId: saved.id,
      details: { description: saved.description, triggerAt: saved.triggerAt },
    });

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      `Reminder **${saved.id}** set for **${saved.triggerAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}**: ${saved.description}`,
      { replyToMessageId: input.rawMessageId },
    );

    return saved;
  }
}
