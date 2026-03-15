import type { QualifiedId } from "../../../domain/ids/QualifiedId";
import type { ReminderRepository } from "../../../domain/repositories/ReminderRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";

export interface ListMyRemindersInput {
  conversationId: QualifiedId;
  targetId: QualifiedId;
  replyToMessageId?: string;
}

export class ListMyReminders {
  constructor(
    private readonly reminders: ReminderRepository,
    private readonly wireOutbound: WireOutboundPort,
  ) {}

  async execute(input: ListMyRemindersInput): Promise<void> {
    const list = await this.reminders.query({
      conversationId: input.conversationId,
      targetId: input.targetId,
      statusIn: ["pending"],
    });

    if (list.length === 0) {
      await this.wireOutbound.sendPlainText(
        input.conversationId,
        "You have no pending reminders in this conversation.",
        { replyToMessageId: input.replyToMessageId },
      );
      return;
    }

    const lines = list
      .sort((a, b) => a.triggerAt.getTime() - b.triggerAt.getTime())
      .map(
        (r) =>
          `- **${r.id}** — ${r.description} _(${r.triggerAt.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })})_`,
      );

    await this.wireOutbound.sendPlainText(
      input.conversationId,
      lines.join("\n"),
      { replyToMessageId: input.replyToMessageId },
    );
  }
}
