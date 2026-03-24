import { describe, it, expect, vi } from "vitest";
import { CatchMeUpCommand } from "../../src/application/usecases/general/CatchMeUpCommand";
import type { QualifiedId } from "../../src/domain/ids/QualifiedId";

const convId: QualifiedId = { id: "conv-1", domain: "wire.com" };
const channelId = "conv-1@wire.com";
const orgId = "wire.com";
const replyToMessageId = "msg-1";

const input = { conversationId: convId, channelId, organisationId: orgId, replyToMessageId };

function makeSummary(ageMs: number) {
  const now = Date.now();
  return {
    id: "sum-1",
    summary: "Productive session.",
    periodStart: new Date(now - ageMs - 60_000),
    periodEnd: new Date(now - 60_000),
    generatedAt: new Date(now - ageMs),
    sentiment: "productive" as const,
    granularity: "daily" as const,
  };
}

describe("CatchMeUpCommand", () => {
  it("posts a cached daily summary when it is fresh (< 25 h old)", async () => {
    const freshSummary = makeSummary(1 * 60 * 60 * 1000); // 1 hour old
    const summaryRepo = { findLatest: vi.fn().mockResolvedValue(freshSummary), findForPeriod: vi.fn() };
    const generateSummary = { execute: vi.fn() };
    const wireOutbound = { sendPlainText: vi.fn().mockResolvedValue(undefined) };

    const cmd = new CatchMeUpCommand(summaryRepo as never, generateSummary as never, wireOutbound as never);
    await cmd.execute(input);

    expect(wireOutbound.sendPlainText).toHaveBeenCalledOnce();
    const [, text] = (wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toContain("Catch-up");
    expect(text).toContain("Productive session.");
    expect(generateSummary.execute).not.toHaveBeenCalled();
  });

  it("generates an on-demand summary when no cached summary exists", async () => {
    const summaryRepo = { findLatest: vi.fn().mockResolvedValue(null), findForPeriod: vi.fn() };
    const generated = {
      id: "sum-2",
      summary: "On-demand: lots of discussion.",
      periodStart: new Date(),
      periodEnd: new Date(),
      sentiment: "routine" as const,
    };
    const generateSummary = { execute: vi.fn().mockResolvedValue(generated) };
    const wireOutbound = { sendPlainText: vi.fn().mockResolvedValue(undefined) };

    const cmd = new CatchMeUpCommand(summaryRepo as never, generateSummary as never, wireOutbound as never);
    await cmd.execute(input);

    expect(generateSummary.execute).toHaveBeenCalledOnce();
    expect(wireOutbound.sendPlainText).toHaveBeenCalledOnce();
    const [, text] = (wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toContain("On-demand: lots of discussion.");
  });

  it("generates on-demand when cached summary is stale (> 25 h)", async () => {
    const staleSummary = makeSummary(26 * 60 * 60 * 1000); // 26 hours old
    const summaryRepo = { findLatest: vi.fn().mockResolvedValue(staleSummary) };
    const generated = { id: "sum-3", summary: "Fresh generation.", periodStart: new Date(), periodEnd: new Date(), sentiment: undefined };
    const generateSummary = { execute: vi.fn().mockResolvedValue(generated) };
    const wireOutbound = { sendPlainText: vi.fn().mockResolvedValue(undefined) };

    const cmd = new CatchMeUpCommand(summaryRepo as never, generateSummary as never, wireOutbound as never);
    await cmd.execute(input);

    expect(generateSummary.execute).toHaveBeenCalledOnce();
  });

  it("posts a fallback message when on-demand generation returns null", async () => {
    const summaryRepo = { findLatest: vi.fn().mockResolvedValue(null) };
    const generateSummary = { execute: vi.fn().mockResolvedValue(null) };
    const wireOutbound = { sendPlainText: vi.fn().mockResolvedValue(undefined) };

    const cmd = new CatchMeUpCommand(summaryRepo as never, generateSummary as never, wireOutbound as never);
    await cmd.execute(input);

    expect(wireOutbound.sendPlainText).toHaveBeenCalledOnce();
    const [, text] = (wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toContain("no record of significant activity");
  });

  it("includes sentiment note in output when sentiment is non-routine", async () => {
    const freshSummary = makeSummary(1 * 60 * 60 * 1000);
    freshSummary.sentiment = "contentious" as never;
    const summaryRepo = { findLatest: vi.fn().mockResolvedValue(freshSummary) };
    const generateSummary = { execute: vi.fn() };
    const wireOutbound = { sendPlainText: vi.fn().mockResolvedValue(undefined) };

    const cmd = new CatchMeUpCommand(summaryRepo as never, generateSummary as never, wireOutbound as never);
    await cmd.execute(input);

    const [, text] = (wireOutbound.sendPlainText as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toContain("contentious");
  });
});
