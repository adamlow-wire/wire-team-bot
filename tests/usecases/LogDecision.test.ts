import { describe, it, expect, vi } from "vitest";
import { LogDecision } from "../../src/application/usecases/decisions/LogDecision";
import type { DecisionRepository } from "../../src/domain/repositories/DecisionRepository";
import type { WireOutboundPort } from "../../src/application/ports/WireOutboundPort";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

describe("LogDecision", () => {
  const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
  const authorId: QualifiedId = { id: "user-1", domain: "wire.com" };

  it("creates decision and sends reply", async () => {
    const decisionsRepo: DecisionRepository = {
      nextId: vi.fn().mockResolvedValue("DEC-0001"),
      create: vi.fn().mockImplementation(async (d) => d),
      update: vi.fn(),
      findById: vi.fn(),
      query: vi.fn(),
    };

    const sent: { text: string }[] = [];
    const wireOutbound: WireOutboundPort = {
      sendPlainText: vi.fn().mockImplementation(async (_c, text) => {
        sent.push({ text });
      }),
      sendCompositePrompt: vi.fn().mockResolvedValue(undefined),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };

    const auditLog = { append: vi.fn().mockResolvedValue(undefined) };
    const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
    const useCase = new LogDecision(decisionsRepo, wireOutbound, auditLog, mockLogger);

    const result = await useCase.execute({
      conversationId: convId,
      authorId,
      authorName: "Alice",
      rawMessageId: "msg-1",
      summary: "We will use Prisma",
      contextMessages: [{ messageId: "context-1", senderId: authorId, senderName: "Alice", text: "PRIVATE_CONTEXT_MARKER", timestamp: new Date() }],
      participantIds: [authorId],
    });

    expect(result.id).toBe("DEC-0001");
    expect(result.summary).toBe("We will use Prisma");
    expect(result.status).toBe("active");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("DEC-0001");
    expect(sent[0].text).toContain("We will use Prisma");
    expect(wireOutbound.sendCompositePrompt).not.toHaveBeenCalled();
    expect(result.context).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CONTEXT_MARKER");
    expect(JSON.stringify(auditLog.append.mock.calls)).not.toContain("PRIVATE_CONTEXT_MARKER");
  });
});
