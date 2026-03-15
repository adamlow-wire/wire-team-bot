/**
 * Integration tests for repositories against Postgres.
 * Require DATABASE_URL and a running Postgres (e.g. docker-compose up -d db).
 * Skip when INTEGRATION_TESTS is not "1".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaTaskRepository } from "../../src/infrastructure/persistence/postgres/PrismaTaskRepository";
import { PrismaDecisionRepository } from "../../src/infrastructure/persistence/postgres/PrismaDecisionRepository";
import { PrismaActionRepository } from "../../src/infrastructure/persistence/postgres/PrismaActionRepository";
import { PrismaReminderRepository } from "../../src/infrastructure/persistence/postgres/PrismaReminderRepository";
import { PrismaKnowledgeRepository } from "../../src/infrastructure/persistence/postgres/PrismaKnowledgeRepository";
import { getPrismaClient } from "../../src/infrastructure/persistence/postgres/PrismaClient";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";
import type { Task } from "../../src/domain/entities/Task";
import type { Decision } from "../../src/domain/entities/Decision";
import type { Action } from "../../src/domain/entities/Action";
import type { Reminder } from "../../src/domain/entities/Reminder";
import type { KnowledgeEntry } from "../../src/domain/entities/KnowledgeEntry";

const skip = process.env.INTEGRATION_TESTS !== "1";

const convId: QualifiedId = { id: "test-conv-integration", domain: "test.domain" };
const authorId: QualifiedId = { id: "test-author-integration", domain: "test.domain" };

// ─── Task ────────────────────────────────────────────────────────────────────

describe.skipIf(skip)("TaskRepository integration", () => {
  const repo = new PrismaTaskRepository();
  let createdId: string;

  afterAll(async () => {
    const prisma = getPrismaClient();
    if (createdId) await prisma.task.deleteMany({ where: { id: createdId } });
    await prisma.$disconnect();
  });

  it("create and findById", async () => {
    const id = await repo.nextId();
    const task: Task = {
      id,
      conversationId: convId,
      authorId,
      authorName: "Integration Test",
      rawMessageId: "msg-1",
      rawMessage: "task: integration test",
      timestamp: new Date(),
      updatedAt: new Date(),
      tags: [],
      status: "open",
      deleted: false,
      version: 1,
      description: "Integration test task",
      assigneeId: authorId,
      assigneeName: "Integration Test",
      creatorId: authorId,
      deadline: null,
      priority: "normal",
      recurrence: null,
      linkedIds: [],
      completionNote: null,
    };
    await repo.create(task);
    createdId = id;

    const found = await repo.findById(id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
    expect(found!.description).toBe("Integration test task");
  });

  it("nextId returns unique values under sequential calls", async () => {
    const a = await repo.nextId();
    const b = await repo.nextId();
    expect(a).not.toBe(b);
  });

  it("update persists status change", async () => {
    const found = await repo.findById(createdId);
    expect(found).not.toBeNull();
    const updated = { ...found!, status: "done" as const, updatedAt: new Date(), version: found!.version + 1 };
    await repo.update(updated);
    const refetched = await repo.findById(createdId);
    expect(refetched!.status).toBe("done");
  });
});

// ─── Decision ────────────────────────────────────────────────────────────────

describe.skipIf(skip)("DecisionRepository integration", () => {
  const repo = new PrismaDecisionRepository();
  let createdId: string;

  afterAll(async () => {
    const prisma = getPrismaClient();
    if (createdId) await prisma.decision.deleteMany({ where: { id: createdId } });
    await prisma.$disconnect();
  });

  it("create, findById, and update status", async () => {
    const id = await repo.nextId();
    const decision: Decision = {
      id,
      conversationId: convId,
      authorId,
      authorName: "Integration Test",
      rawMessageId: "msg-d1",
      rawMessage: "decision: use Postgres",
      summary: "Use Postgres",
      context: [],
      participants: [authorId],
      status: "active",
      supersededBy: null,
      supersedes: null,
      linkedIds: [],
      attachments: [],
      tags: [],
      timestamp: new Date(),
      updatedAt: new Date(),
      deleted: false,
      version: 1,
    };
    await repo.create(decision);
    createdId = id;

    const found = await repo.findById(id);
    expect(found!.summary).toBe("Use Postgres");
    expect(found!.status).toBe("active");

    await repo.update({ ...found!, status: "revoked", version: 2, updatedAt: new Date() });
    const refetched = await repo.findById(id);
    expect(refetched!.status).toBe("revoked");
  });
});

// ─── Action ──────────────────────────────────────────────────────────────────

describe.skipIf(skip)("ActionRepository integration", () => {
  const repo = new PrismaActionRepository();
  let createdId: string;

  afterAll(async () => {
    const prisma = getPrismaClient();
    if (createdId) await prisma.action.deleteMany({ where: { id: createdId } });
    await prisma.$disconnect();
  });

  it("create and findById", async () => {
    const id = await repo.nextId();
    const action: Action = {
      id,
      conversationId: convId,
      creatorId: authorId,
      authorName: "Integration Test",
      assigneeId: authorId,
      assigneeName: "Integration Test",
      rawMessageId: "msg-a1",
      rawMessage: "action: do the thing",
      description: "Do the thing",
      deadline: null,
      status: "open",
      linkedIds: [],
      reminderAt: [],
      completionNote: null,
      tags: [],
      timestamp: new Date(),
      updatedAt: new Date(),
      deleted: false,
      version: 1,
    };
    await repo.create(action);
    createdId = id;

    const found = await repo.findById(id);
    expect(found!.description).toBe("Do the thing");
  });
});

// ─── Reminder ────────────────────────────────────────────────────────────────

describe.skipIf(skip)("ReminderRepository integration", () => {
  const repo = new PrismaReminderRepository();
  let createdId: string;

  afterAll(async () => {
    const prisma = getPrismaClient();
    if (createdId) await prisma.reminder.deleteMany({ where: { id: createdId } });
    await prisma.$disconnect();
  });

  it("create, findById, and query pending", async () => {
    const id = await repo.nextId();
    const triggerAt = new Date(Date.now() + 60_000);
    const reminder: Reminder = {
      id,
      conversationId: convId,
      authorId,
      authorName: "Integration Test",
      rawMessageId: "msg-r1",
      rawMessage: "remind me in 1 minute",
      timestamp: new Date(),
      updatedAt: new Date(),
      createdAt: new Date(),
      tags: [],
      status: "pending",
      deleted: false,
      version: 1,
      description: "Integration test reminder",
      targetId: authorId,
      triggerAt,
      recurrence: null,
      linkedIds: [],
    };
    await repo.create(reminder);
    createdId = id;

    const found = await repo.findById(id);
    expect(found!.description).toBe("Integration test reminder");
    expect(found!.status).toBe("pending");

    const pending = await repo.query({ statusIn: ["pending"] });
    expect(pending.some((r) => r.id === id)).toBe(true);
  });
});

// ─── KnowledgeEntry ──────────────────────────────────────────────────────────

describe.skipIf(skip)("KnowledgeRepository integration", () => {
  const repo = new PrismaKnowledgeRepository();
  let createdId: string;

  afterAll(async () => {
    const prisma = getPrismaClient();
    if (createdId) await prisma.knowledgeEntry.deleteMany({ where: { id: createdId } });
    await prisma.$disconnect();
  });

  it("create, findById, and incrementRetrievalCount", async () => {
    const id = await repo.nextId();
    const entry: KnowledgeEntry = {
      id,
      conversationId: convId,
      authorId,
      authorName: "Integration Test",
      rawMessageId: "msg-k1",
      rawMessage: "knowledge: rate limit 500/min",
      summary: "Rate limit is 500/min",
      detail: "The API rate limit is 500 requests per minute.",
      category: "factual",
      confidence: "high",
      relatedIds: [],
      ttlDays: 90,
      verifiedBy: [],
      retrievalCount: 0,
      lastRetrieved: null,
      tags: [],
      timestamp: new Date(),
      updatedAt: new Date(),
      deleted: false,
      version: 1,
    };
    await repo.create(entry);
    createdId = id;

    const found = await repo.findById(id);
    expect(found!.summary).toBe("Rate limit is 500/min");
    expect(found!.retrievalCount).toBe(0);

    await repo.incrementRetrievalCount(id);
    const updated = await repo.findById(id);
    expect(updated!.retrievalCount).toBe(1);
  });
});
