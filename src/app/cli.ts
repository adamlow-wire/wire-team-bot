/**
 * CLI harness for Wire Team Bot — drives WireEventRouter directly from stdin/stdout.
 *
 * Usage (interactive):
 *   npm run cli
 *
 * Usage (scripted — for agents and automated tests):
 *   printf "decision: we use Postgres\n@Wire Team Bot what decisions have we made?\n" | npm run cli
 *
 * Message format:
 *   <message>                    — sent as the default user (Alice)
 *   <Name>: <message>            — sent as a named member (must be in the seeded roster)
 *
 * Wire Team Bot responses are printed prefixed with "[Wire Team Bot]".
 * All other bot log output goes to stderr so stdout stays clean for scripted use.
 *
 * Exit: send EOF (Ctrl-D) or the word "exit" / "quit".
 */

import "reflect-metadata";
import readline from "readline";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config";
import { initLogging, getLogger } from "./logging";
import { getPrismaClient } from "../infrastructure/persistence/postgres/PrismaClient";
import { WireEventRouter } from "../infrastructure/wire/WireEventRouter";
import type { WireOutboundPort, OutboundTextOptions } from "../application/ports/WireOutboundPort";
import type { QualifiedId } from "../domain/ids/QualifiedId";
import { toChannelId } from "../domain/ids/channelId";
import { PrismaDecisionRepository } from "../infrastructure/persistence/postgres/PrismaDecisionRepository";
import { PrismaActionRepository } from "../infrastructure/persistence/postgres/PrismaActionRepository";
import { PrismaReminderRepository } from "../infrastructure/persistence/postgres/PrismaReminderRepository";
import { PrismaConversationConfigRepository } from "../infrastructure/persistence/postgres/PrismaConversationConfigRepository";
import { PrismaChannelConfigRepository } from "../infrastructure/persistence/postgres/PrismaChannelConfigRepository";
import { PrismaAuditLogRepository } from "../infrastructure/persistence/postgres/PrismaAuditLogRepository";
import { PrismaEntityRepository } from "../infrastructure/persistence/postgres/PrismaEntityRepository";
import { PrismaEmbeddingRepository } from "../infrastructure/persistence/postgres/PrismaEmbeddingRepository";
import { PrismaConversationSignalRepository } from "../infrastructure/persistence/postgres/PrismaConversationSignalRepository";
import { PrismaConversationSummaryRepository } from "../infrastructure/persistence/postgres/PrismaConversationSummaryRepository";
import { SlidingWindowBuffer } from "../infrastructure/buffer/SlidingWindowBuffer";
import { ConversationMessageBuffer } from "../application/services/ConversationMessageBuffer";
import { InMemoryMemberCache } from "../infrastructure/services/InMemoryMemberCache";
import { MemberCacheUserResolutionService } from "../infrastructure/services/MemberCacheUserResolutionService";
import { SystemDateTimeService } from "../infrastructure/services/SystemDateTimeService";
import { InProcessScheduler } from "../infrastructure/scheduler/InProcessScheduler";
import { InMemoryProcessingQueue } from "../infrastructure/queue/InMemoryProcessingQueue";
import { ProcessingPipeline } from "../infrastructure/pipeline/ProcessingPipeline";
import type { MessageJob } from "../infrastructure/pipeline/ProcessingPipeline";
import { LLMClientFactory } from "../infrastructure/llm/LLMClientFactory";
import { OpenAIGeneralAnswerAdapter } from "../infrastructure/llm/OpenAIGeneralAnswerAdapter";
import { OpenAIClassifierAdapter } from "../infrastructure/llm/OpenAIClassifierAdapter";
import { OpenAIExtractionAdapter } from "../infrastructure/llm/OpenAIExtractionAdapter";
import { createEmbeddingService } from "../infrastructure/llm/createEmbeddingService";
import { OpenAIQueryAnalysisAdapter } from "../infrastructure/llm/OpenAIQueryAnalysisAdapter";
import { OpenAISummarisationAdapter } from "../infrastructure/llm/OpenAISummarisationAdapter";
import { LogDecision } from "../application/usecases/decisions/LogDecision";
import { SearchDecisions } from "../application/usecases/decisions/SearchDecisions";
import { ListDecisions } from "../application/usecases/decisions/ListDecisions";
import { SupersedeDecision } from "../application/usecases/decisions/SupersedeDecision";
import { RevokeDecision } from "../application/usecases/decisions/RevokeDecision";
import { CreateActionFromExplicit } from "../application/usecases/actions/CreateActionFromExplicit";
import { UpdateActionStatus } from "../application/usecases/actions/UpdateActionStatus";
import { ListMyActions } from "../application/usecases/actions/ListMyActions";
import { ListTeamActions } from "../application/usecases/actions/ListTeamActions";
import { ReassignAction } from "../application/usecases/actions/ReassignAction";
import { UpdateActionDeadline } from "../application/usecases/actions/UpdateActionDeadline";
import { ListOverdueActions } from "../application/usecases/actions/ListOverdueActions";
import { CreateReminder } from "../application/usecases/reminders/CreateReminder";
import { ListMyReminders } from "../application/usecases/reminders/ListMyReminders";
import { CancelReminder } from "../application/usecases/reminders/CancelReminder";
import { SnoozeReminder } from "../application/usecases/reminders/SnoozeReminder";
import { AnswerQuestion } from "../application/usecases/general/AnswerQuestion";
import { StatusCommand } from "../application/usecases/general/StatusCommand";
import { GenerateSummary } from "../application/usecases/general/GenerateSummary";
import { CatchMeUpCommand } from "../application/usecases/general/CatchMeUpCommand";
import { StructuredRetrievalPath } from "../infrastructure/retrieval/StructuredRetrievalPath";
import { SemanticRetrievalPath } from "../infrastructure/retrieval/SemanticRetrievalPath";
import { GraphRetrievalPath } from "../infrastructure/retrieval/GraphRetrievalPath";
import { SummaryRetrievalPath } from "../infrastructure/retrieval/SummaryRetrievalPath";
import { MultiPathRetrievalEngine } from "../infrastructure/retrieval/MultiPathRetrievalEngine";

// ── Fixed identities ──────────────────────────────────────────────────────────

const DOMAIN = "cli.local";
// Allow E2E tests to inject a unique channel ID per scenario for DB isolation.
const CHANNEL_ID_RAW: QualifiedId = {
  id: process.env.E2E_CHANNEL_ID ?? "cli-channel",
  domain: DOMAIN,
};
const BOT_ID: QualifiedId = { id: "wire-team-bot", domain: DOMAIN };

/** Seeded roster — members available to send messages as. */
const MEMBERS: Array<{ name: string; id: QualifiedId }> = [
  { name: "Alice", id: { id: "alice", domain: DOMAIN } },
  { name: "Bob",   id: { id: "bob",   domain: DOMAIN } },
  { name: "Carol", id: { id: "carol", domain: DOMAIN } },
  { name: "Dave",  id: { id: "dave",  domain: DOMAIN } },
];

// ── Stub outbound port ────────────────────────────────────────────────────────

const evaluationMode = process.env.E2E_JSON === "1";
let evaluationReplies: string[] = [];
let evaluationReactions: Array<{ messageId: string; emojis: string[] }> = [];

function createCliOutbound(): WireOutboundPort {
  return {
    async sendPlainText(_convId: QualifiedId, text: string, _opts?: OutboundTextOptions) {
      if (evaluationMode) evaluationReplies.push(text);
      else process.stdout.write(`[Wire Team Bot] ${text}\n`);
    },
    async sendCompositePrompt(_convId: QualifiedId, text: string) {
      if (evaluationMode) evaluationReplies.push(text);
      else process.stdout.write(`[Wire Team Bot] ${text}\n`);
    },
    async sendReaction(_conversationId, messageId, emoji) {
      const emojis = typeof emoji === "string" ? [emoji] : [...emoji];
      if (evaluationMode) evaluationReactions.push({ messageId, emojis });
      else process.stdout.write(`[Wire Team Bot reaction] ${emojis.join(" ")}\n`);
    },
    async sendFile() {},
    async getUserProfile(userId: QualifiedId) {
      const m = MEMBERS.find((mem) => mem.id.id === userId.id);
      return m ? { id: userId, name: m.name } : null;
    },
  };
}

// ── Fake TextMessage builder ──────────────────────────────────────────────────

function buildMessage(text: string, sender: QualifiedId): object {
  const botMentionPattern = /^@(?:wire team bot)\b/i;
  const mentions = botMentionPattern.test(text.trim())
    ? [{ userId: BOT_ID, offset: text.indexOf("@"), length: text.trim().match(botMentionPattern)![0].length }]
    : [];
  // The synthetic roster's @names model actual Wire person mentions in e2e.
  for (const match of text.matchAll(/@(Alice|Bob|Carol|Dave)\b/gi)) {
    const member = MEMBERS.find(m => m.name.toLowerCase() === match[1].toLowerCase())!;
    mentions.push({ userId: member.id, offset: match.index!, length: match[0].length });
  }
  return {
    id: `cli-msg-${randomUUID()}`,
    conversationId: CHANNEL_ID_RAW,
    sender,
    text,
    mentions,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  // Suppress info logs to stderr so stdout stays clean for scripted use
  initLogging(process.env.LOG_LEVEL ?? "warn");
  const logger = getLogger();

  const prisma = getPrismaClient();

  // Repos
  const decisionsRepo     = new PrismaDecisionRepository();
  const actionsRepo       = new PrismaActionRepository();
  const remindersRepo     = new PrismaReminderRepository();
  const convConfigRepo    = new PrismaConversationConfigRepository();
  const channelConfigRepo = new PrismaChannelConfigRepository();
  const auditLogRepo      = new PrismaAuditLogRepository();
  const entityRepo        = new PrismaEntityRepository();
  const embeddingRepo     = new PrismaEmbeddingRepository(logger);
  const signalRepo        = new PrismaConversationSignalRepository();
  const summaryRepo       = new PrismaConversationSummaryRepository();

  // Services
  const slidingWindow   = new SlidingWindowBuffer();
  const messageBuffer   = new ConversationMessageBuffer(config.app.messageBufferSize);
  const memberCache     = new InMemoryMemberCache();
  const userResolution  = new MemberCacheUserResolutionService(memberCache);
  // Clock injection is confined to the synthetic CLI; the Wire app always uses
  // the real clock. Timers/queue draining continue to use real elapsed time.
  const referenceTime = evaluationMode && process.env.E2E_REFERENCE_TIME
    ? new Date(process.env.E2E_REFERENCE_TIME) : undefined;
  if (referenceTime && !Number.isFinite(referenceTime.getTime())) throw new Error("Invalid E2E_REFERENCE_TIME");
  const timezone = evaluationMode ? process.env.E2E_TIMEZONE ?? "UTC" : "UTC";
  new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
  const dateTimeService = new SystemDateTimeService(referenceTime ? () => new Date(referenceTime) : undefined);
  const scheduler       = new InProcessScheduler(logger);
  const llmFactory      = new LLMClientFactory(config.llm.bot, logger);

  // Seed member cache with the CLI roster + bot
  const channelId = toChannelId(CHANNEL_ID_RAW);
  memberCache.setMembers(CHANNEL_ID_RAW, [
    ...MEMBERS.map(m => ({ userId: m.id, role: "member" as const, name: m.name })),
    { userId: BOT_ID, role: "member" as const },
  ]);

  // Ensure channel exists as active
  const existing = await channelConfigRepo.get(channelId);
  if (!existing) {
    await channelConfigRepo.upsert({
      channelId,
      organisationId: DOMAIN,
      state: "active",
      secureRanges: [],
      tags: [],
      stakeholders: [],
      relatedChannels: [],
      timezone,
      locale: "en",
      joinedAt: new Date(),
    });
  }

  // Outbound
  const wireOutbound = createCliOutbound();

  // Pipeline
  const classifier       = new OpenAIClassifierAdapter(llmFactory, logger);
  const extraction       = new OpenAIExtractionAdapter(llmFactory, logger);
  const embeddingService = createEmbeddingService(config.llm.bot, logger);
  const pipeline         = new ProcessingPipeline({
    auditLog: auditLogRepo,
    userResolution: userResolution, dateTimeService,
    classifier, extraction, embeddingService,
    entityRepo, embeddingRepo, signalRepo,
    decisionRepo: decisionsRepo, actionRepo: actionsRepo,
    channelConfig: channelConfigRepo, slidingWindow, wireOutbound, llm: llmFactory,
    logger,
    extractConfidenceMin:   config.llm.bot.extractConfidenceMin,
    contradictionThreshold: config.llm.bot.contradictionThreshold,
  });
  const processingQueue = new InMemoryProcessingQueue<MessageJob>((msg, meta) => logger.warn(msg, meta));
  processingQueue.setWorker(job => pipeline.process(job.payload, job.signal));

  // Retrieval
  const queryAnalysis    = new OpenAIQueryAnalysisAdapter(llmFactory, logger);
  const structuredPath   = new StructuredRetrievalPath(decisionsRepo, actionsRepo);
  const semanticPath     = new SemanticRetrievalPath(embeddingService, embeddingRepo, decisionsRepo, actionsRepo, logger);
  const graphPath        = new GraphRetrievalPath(logger);
  const summarisationAdapter = new OpenAISummarisationAdapter(llmFactory, logger);
  const generateSummary  = new GenerateSummary(summarisationAdapter, signalRepo, decisionsRepo, actionsRepo, summaryRepo, logger);
  const summaryPath      = new SummaryRetrievalPath(summaryRepo, logger);
  const retrievalEngine  = new MultiPathRetrievalEngine(structuredPath, semanticPath, graphPath, summaryPath, logger);

  // Use cases
  const answerQuestion = new AnswerQuestion(generalAnswerAdapter(llmFactory, logger), wireOutbound, queryAnalysis, retrievalEngine, logger);
  const statusCommand  = new StatusCommand(channelConfigRepo, entityRepo, actionsRepo, remindersRepo, decisionsRepo, wireOutbound);
  const catchMeUp      = new CatchMeUpCommand(summaryRepo, generateSummary, wireOutbound);

  const router = new WireEventRouter({
    logger,
    botUserId: BOT_ID,
    logDecision:            new LogDecision(decisionsRepo, wireOutbound, auditLogRepo, logger),
    searchDecisions:        new SearchDecisions(decisionsRepo, wireOutbound),
    listDecisions:          new ListDecisions(decisionsRepo, wireOutbound),
    supersedeDecision:      new SupersedeDecision(decisionsRepo, wireOutbound, auditLogRepo),
    revokeDecision:         new RevokeDecision(decisionsRepo, wireOutbound, auditLogRepo),
    createActionFromExplicit: new CreateActionFromExplicit(actionsRepo, convConfigRepo, dateTimeService, userResolution, wireOutbound, auditLogRepo, logger),
    updateActionStatus:     new UpdateActionStatus(actionsRepo, wireOutbound, auditLogRepo),
    updateActionDeadline:   new UpdateActionDeadline(actionsRepo, dateTimeService, wireOutbound, auditLogRepo),
    listMyActions:          new ListMyActions(actionsRepo, wireOutbound),
    listTeamActions:        new ListTeamActions(actionsRepo, wireOutbound),
    listOverdueActions:     new ListOverdueActions(actionsRepo, wireOutbound),
    reassignAction:         new ReassignAction(actionsRepo, userResolution, wireOutbound, auditLogRepo),
    createReminder:         new CreateReminder(remindersRepo, dateTimeService, wireOutbound, scheduler, auditLogRepo, logger),
    listMyReminders:        new ListMyReminders(remindersRepo, wireOutbound),
    cancelReminder:         new CancelReminder(remindersRepo, scheduler, wireOutbound, auditLogRepo),
    snoozeReminder:         new SnoozeReminder(remindersRepo, dateTimeService, scheduler, wireOutbound, auditLogRepo),
    answerQuestion,
    statusCommand,
    catchMeUpCommand:       catchMeUp,
    wireOutbound,
    dateTimeService,
    scheduler,
    secretModeInactivityMs: 30 * 60 * 1000,
    memberCache,
    messageBuffer,
    slidingWindow,
    conversationConfig:     convConfigRepo,
    channelConfig:          channelConfigRepo,
    processingQueue,
    pipeline,
    orgId:                  DOMAIN,
  });

  const isInteractive = process.stdin.isTTY;

  if (isInteractive) {
    process.stderr.write(`Wire Team Bot CLI — type messages, prefix with "Name: " to change sender\n`);
    process.stderr.write(`Members: ${MEMBERS.map(m => m.name).join(", ")}\n`);
    process.stderr.write(`Type "exit" or Ctrl-D to quit.\n\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: undefined, terminal: false });

  for await (const line of rl) {
    const event = evaluationMode ? JSON.parse(line) as { eventId: string; text: string } : null;
    const trimmed = (event?.text ?? line).trim();
    evaluationReplies = [];
    evaluationReactions = [];
    const started = Date.now();
    if (!trimmed) continue;
    if (trimmed === "exit" || trimmed === "quit") break;

    // Parse "Name: message" or default to Alice
    const senderMatch = trimmed.match(/^([A-Za-z][A-Za-z0-9 ]*?):\s+(.+)$/);
    let sender = MEMBERS[0]!.id;
    let text = trimmed;

    if (senderMatch) {
      const name = senderMatch[1]!.trim();
      const found = MEMBERS.find(m => m.name.toLowerCase() === name.toLowerCase());
      if (found) {
        sender = found.id;
        text = senderMatch[2]!;
      }
    }

    if (isInteractive) {
      const senderName = MEMBERS.find(m => m.id.id === sender.id)?.name ?? sender.id;
      process.stderr.write(`[${senderName}] ${text}\n`);
    }

    const msg = { ...buildMessage(text, sender), ...(event ? { id: event.eventId } : {}) };
    await router.onTextMessageReceived(msg as Parameters<typeof router.onTextMessageReceived>[0]);
    if (event) {
      await processingQueue.waitForIdle(180_000);
      process.stdout.write(JSON.stringify({ eventId: event.eventId, replies: evaluationReplies, reactions: evaluationReactions, elapsedMs: Date.now() - started }) + "\n");
    }
  }

  // Drain any in-flight pipeline jobs before closing the DB connection.
  // Without this, background-extracted decisions/actions (TC-PIPE) are lost
  // because the Prisma connection closes before the async writes commit.
  await processingQueue.waitForIdle(180_000);

  scheduler.shutdown();
  await prisma.$disconnect();
}

// Tiny helper — avoids duplicating the adapter construction
function generalAnswerAdapter(llmFactory: LLMClientFactory, logger: ReturnType<typeof getLogger>) {
  return new OpenAIGeneralAnswerAdapter(llmFactory, logger);
}

main().catch(() => {
  process.stderr.write("CLI failed; verify configuration and service availability\n");
  process.exit(1);
});
