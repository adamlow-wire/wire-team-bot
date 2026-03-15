import type { Decision } from "../../../domain/entities/Decision";
import type { DecisionRepository } from "../../../domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../ports/WireOutboundPort";
import type { AuditLogRepository } from "../../../domain/repositories/AuditLogRepository";
import type { QualifiedId } from "../../../domain/ids/QualifiedId";

export interface RevokeDecisionInput {
  decisionId: string;
  conversationId: QualifiedId;
  actorId: QualifiedId;
  reason?: string;
  replyToMessageId?: string;
}

export class RevokeDecision {
  constructor(
    private readonly decisions: DecisionRepository,
    private readonly wireOutbound: WireOutboundPort,
    private readonly auditLog: AuditLogRepository,
  ) {}

  async execute(input: RevokeDecisionInput): Promise<Decision | null> {
    const decision = await this.decisions.findById(input.decisionId);
    if (!decision || decision.conversationId.id !== input.conversationId.id) {
      return null;
    }

    const updated: Decision = {
      ...decision,
      status: "revoked",
      updatedAt: new Date(),
      version: decision.version + 1,
    };

    await this.decisions.update(updated);

    await this.auditLog.append({
      timestamp: new Date(),
      actorId: input.actorId,
      conversationId: input.conversationId,
      action: "entity_updated",
      entityType: "Decision",
      entityId: input.decisionId,
      details: { status: "revoked", reason: input.reason },
    });

    const msg = input.reason
      ? `${input.decisionId} revoked. Reason: ${input.reason}`
      : `${input.decisionId} revoked.`;

    await this.wireOutbound.sendPlainText(input.conversationId, msg, {
      replyToMessageId: input.replyToMessageId,
    });

    return updated;
  }
}
