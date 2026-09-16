import { afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getPrismaClient } from "../../src/infrastructure/persistence/postgres/PrismaClient";
import { PrismaDecisionRepository } from "../../src/infrastructure/persistence/postgres/PrismaDecisionRepository";
import { PrismaActionRepository } from "../../src/infrastructure/persistence/postgres/PrismaActionRepository";
import { PrismaReminderRepository } from "../../src/infrastructure/persistence/postgres/PrismaReminderRepository";
import { PrismaAuditLogRepository } from "../../src/infrastructure/persistence/postgres/PrismaAuditLogRepository";
import { PrismaEmbeddingRepository } from "../../src/infrastructure/persistence/postgres/PrismaEmbeddingRepository";
import { LogDecision } from "../../src/application/usecases/decisions/LogDecision";
import { FireReminder } from "../../src/application/usecases/reminders/FireReminder";
import { StructuredRetrievalPath } from "../../src/infrastructure/retrieval/StructuredRetrievalPath";

describe.skipIf(process.env.INTEGRATION_TESTS !== "1")("pilot persisted safety", () => {
  const conv = { id: `safety-${randomUUID()}`, domain: "synthetic.test" };
  const actor = { id: "alice", domain: conv.domain };
  const scope = { conversationId: conv.id, conversationDom: conv.domain };
  const logger = { child: vi.fn().mockReturnThis(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const wire = { sendPlainText: vi.fn().mockResolvedValue(undefined) };
  afterAll(async () => {
    const db = getPrismaClient();
    await db.decision.deleteMany({ where: scope });
    await db.reminder.deleteMany({ where: scope });
    await db.auditLog.deleteMany({ where: scope });
    await db.$executeRaw`DELETE FROM embeddings WHERE channel_id = ${`${conv.id}@${conv.domain}`}`;
    await db.$disconnect();
  });
  it("does not persist surrounding context and denies a guessed foreign-domain ID", async () => {
    const decisions = new PrismaDecisionRepository();
    const audit = new PrismaAuditLogRepository();
    const input = { conversationId: conv, authorId: actor, authorName: "Alice", rawMessageId: "source-decision", summary: "Use Postgres", participantIds: [actor],
      contextMessages: [{ senderId: actor, senderName: "Alice", messageId: "context", text: "PRIVATE_CONTEXT_MARKER", timestamp: new Date() }] };
    const useCase = new LogDecision(decisions,wire as never,audit,logger);
    const saved = await useCase.execute(input);
    await useCase.execute(input);
    await useCase.execute({ ...input, rawMessageId: "source-other", summary: "Use Redis" });
    const rows = await getPrismaClient().decision.findMany({ where: scope });
    const auditRows = await getPrismaClient().auditLog.findMany({ where: scope });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify({rows,auditRows,logs:logger.info.mock.calls})).not.toContain("PRIVATE_CONTEXT_MARKER");
    expect(auditRows.some(row => row.entityId === saved.id)).toBe(true);
    const retrieval = new StructuredRetrievalPath(decisions,new PrismaActionRepository());
    const plan = { intent: "factual_recall", entities: [saved.id], timeRange: null } as never;
    expect(await retrieval.retrieve(plan,{organisationId:"foreign.test",channelId:`${conv.id}@foreign.test`})).toEqual([]);
    expect(await retrieval.retrieve(plan,{organisationId:conv.domain,channelId:`${conv.id}@${conv.domain}`})).toHaveLength(2);
  });
  it("recovers an overdue failed reminder from durable pending state after reconstruction", async () => {
    const reminders = new PrismaReminderRepository();
    const audit = new PrismaAuditLogRepository();
    const scheduler = { schedule: vi.fn(), cancel: vi.fn() };
    const id = await reminders.nextId();
    const now = new Date();
    await reminders.create({ id, conversationId: conv, authorId: actor, authorName: "Alice", rawMessageId: "source-reminder", description: "Check deployment", targetId: actor,
      triggerAt: new Date(now.getTime()-60_000), status:"pending",timestamp:now,createdAt:now,updatedAt:now,tags:[],linkedIds:[],deleted:false,version:1 });
    wire.sendPlainText.mockRejectedValueOnce(new Error("offline"));
    await expect(new FireReminder(reminders,wire as never,audit,actor,scheduler).execute({reminderId:id})).rejects.toThrow("offline");
    const restoredRepo = new PrismaReminderRepository();
    const pending = await restoredRepo.query({conversationId:conv,statusIn:["pending"]});
    expect(pending.map(r=>r.id)).toContain(id);
    await new FireReminder(restoredRepo,wire as never,audit,actor,scheduler).execute({reminderId:id});
    expect((await restoredRepo.findById(id))?.status).toBe("fired");
  });
  it("stores and retrieves a 2560-dimensional vector only in its qualified channel", async () => {
    const repository = new PrismaEmbeddingRepository(logger);
    const vector = Array.from({length:2560},(_,i)=>i===0?1:0);
    const channelId = `${conv.id}@${conv.domain}`;
    await repository.store({sourceType:"decision",sourceId:"synthetic",channelId,orgId:conv.domain,createdAt:new Date(),topicTags:[],embedding:vector});
    expect(await repository.findSimilar(channelId,vector,5)).toHaveLength(1);
    expect(await repository.findSimilar(`${conv.id}@foreign.test`,vector,5)).toEqual([]);
  });
});
