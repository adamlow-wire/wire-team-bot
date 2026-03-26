import "reflect-metadata";
import fs from "fs";
import path from "node:path";
import type { WireAppSdk } from "wire-apps-js-sdk";
import type { Config } from "./config";
import type { Logger } from "./logging";
import { createWireOutboundAdapter, type HandlerManagerRef } from "../infrastructure/wire/WireOutboundAdapter";
import { WireEventRouter } from "../infrastructure/wire/WireEventRouter";
import { createWireClient } from "../infrastructure/wire/WireClient";
import { PrismaDecisionRepository } from "../infrastructure/persistence/postgres/PrismaDecisionRepository";
import { PrismaActionRepository } from "../infrastructure/persistence/postgres/PrismaActionRepository";
import { PrismaReminderRepository } from "../infrastructure/persistence/postgres/PrismaReminderRepository";
import { PrismaConversationConfigRepository } from "../infrastructure/persistence/postgres/PrismaConversationConfigRepository";
import { PrismaChannelConfigRepository } from "../infrastructure/persistence/postgres/PrismaChannelConfigRepository";
import { SlidingWindowBuffer } from "../infrastructure/buffer/SlidingWindowBuffer";
import { PrismaAuditLogRepository } from "../infrastructure/persistence/postgres/PrismaAuditLogRepository";
import { SystemDateTimeService } from "../infrastructure/services/SystemDateTimeService";
import { MemberCacheUserResolutionService } from "../infrastructure/services/MemberCacheUserResolutionService";
import { InMemoryMemberCache } from "../infrastructure/services/InMemoryMemberCache";
import { InProcessScheduler } from "../infrastructure/scheduler/InProcessScheduler";
import { ConversationMessageBuffer } from "../application/services/ConversationMessageBuffer";
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
import { FireReminder } from "../application/usecases/reminders/FireReminder";
import { CancelReminder } from "../application/usecases/reminders/CancelReminder";
import { SnoozeReminder } from "../application/usecases/reminders/SnoozeReminder";
import type { ScheduledJob } from "../application/ports/SchedulerPort";
import { getPrismaClient } from "../infrastructure/persistence/postgres/PrismaClient";
import { OpenAIGeneralAnswerAdapter } from "../infrastructure/llm/OpenAIGeneralAnswerAdapter";
import { LLMClientFactory } from "../infrastructure/llm/LLMClientFactory";
import { OpenAIClassifierAdapter } from "../infrastructure/llm/OpenAIClassifierAdapter";
import { OpenAIExtractionAdapter } from "../infrastructure/llm/OpenAIExtractionAdapter";
import { JeevesEmbeddingAdapter } from "../infrastructure/llm/JeevesEmbeddingAdapter";
import { PrismaEntityRepository } from "../infrastructure/persistence/postgres/PrismaEntityRepository";
import { PrismaEmbeddingRepository } from "../infrastructure/persistence/postgres/PrismaEmbeddingRepository";
import { PrismaConversationSignalRepository } from "../infrastructure/persistence/postgres/PrismaConversationSignalRepository";
import { InMemoryProcessingQueue } from "../infrastructure/queue/InMemoryProcessingQueue";
import { ProcessingPipeline } from "../infrastructure/pipeline/ProcessingPipeline";
import type { MessageJob } from "../infrastructure/pipeline/ProcessingPipeline";
import { AnswerQuestion } from "../application/usecases/general/AnswerQuestion";
import { StatusCommand } from "../application/usecases/general/StatusCommand";
import { GenerateSummary } from "../application/usecases/general/GenerateSummary";
import { CatchMeUpCommand } from "../application/usecases/general/CatchMeUpCommand";
import { CheckStaleness } from "../application/usecases/actions/CheckStaleness";
import { OpenAIQueryAnalysisAdapter } from "../infrastructure/llm/OpenAIQueryAnalysisAdapter";
import { OpenAISummarisationAdapter } from "../infrastructure/llm/OpenAISummarisationAdapter";
import { StructuredRetrievalPath } from "../infrastructure/retrieval/StructuredRetrievalPath";
import { SemanticRetrievalPath } from "../infrastructure/retrieval/SemanticRetrievalPath";
import { GraphRetrievalPath } from "../infrastructure/retrieval/GraphRetrievalPath";
import { SummaryRetrievalPath } from "../infrastructure/retrieval/SummaryRetrievalPath";
import { MultiPathRetrievalEngine } from "../infrastructure/retrieval/MultiPathRetrievalEngine";
import { PrismaConversationSummaryRepository } from "../infrastructure/persistence/postgres/PrismaConversationSummaryRepository";

export interface Container {
  getWireClient(): Promise<WireAppSdk>;
  shutdown(): Promise<void>;
}

export function createContainer(config: Config, logger: Logger): Container {
  const handlerRef: HandlerManagerRef = { current: null };

  const wireOutbound = createWireOutboundAdapter(handlerRef, logger);

  const decisionsRepo = new PrismaDecisionRepository();
  const actionsRepo = new PrismaActionRepository();
  const remindersRepo = new PrismaReminderRepository();
  const conversationConfigRepo = new PrismaConversationConfigRepository();
  const channelConfigRepo = new PrismaChannelConfigRepository();
  const slidingWindow = new SlidingWindowBuffer();
  const auditLogRepo = new PrismaAuditLogRepository();
  const systemActorId = { id: config.wire.userId, domain: config.wire.userDomain };
  const dateTimeService = new SystemDateTimeService();
  const memberCache = new InMemoryMemberCache();
  const userResolutionService = new MemberCacheUserResolutionService(memberCache);
  const messageBuffer = new ConversationMessageBuffer(config.app.messageBufferSize);
  const scheduler = new InProcessScheduler(logger);

  const generalAnswerAdapter = new OpenAIGeneralAnswerAdapter(new LLMClientFactory(config.llm.jeeves, logger), logger);

  // ── Phase 2: Intelligence pipeline ──────────────────────────────────────
  const llmFactory = new LLMClientFactory(config.llm.jeeves, logger);
  const classifier = new OpenAIClassifierAdapter(llmFactory, logger);
  const extraction = new OpenAIExtractionAdapter(llmFactory, logger);
  const embeddingService = new JeevesEmbeddingAdapter(config.llm.jeeves, logger);
  const entityRepo = new PrismaEntityRepository();
  const embeddingRepo = new PrismaEmbeddingRepository(logger);
  const signalRepo = new PrismaConversationSignalRepository();

  const pipeline = new ProcessingPipeline({
    classifier,
    extraction,
    embeddingService,
    entityRepo,
    embeddingRepo,
    signalRepo,
    decisionRepo: decisionsRepo,
    actionRepo: actionsRepo,
    channelConfig: channelConfigRepo,
    slidingWindow,
    wireOutbound,
    llm: llmFactory,
    logger,
    extractConfidenceMin: config.llm.jeeves.extractConfidenceMin,
    contradictionThreshold: config.llm.jeeves.contradictionThreshold,
  });

  const processingQueue = new InMemoryProcessingQueue<MessageJob>(
    (msg, meta) => logger.warn(msg, meta),
  );
  processingQueue.setWorker((job) => pipeline.process(job.payload));

  // ── Phase 3: Multi-path retrieval engine ────────────────────────────────
  const queryAnalysis = new OpenAIQueryAnalysisAdapter(llmFactory, logger);
  const structuredPath = new StructuredRetrievalPath(decisionsRepo, actionsRepo);
  const semanticPath = new SemanticRetrievalPath(
    embeddingService,
    embeddingRepo,
    decisionsRepo,
    actionsRepo,
    logger,
  );
  const graphPath = new GraphRetrievalPath(logger);

  // ── Phase 4: Summaries + Proactive ──────────────────────────────────────
  const summaryRepo = new PrismaConversationSummaryRepository();
  const summarisationAdapter = new OpenAISummarisationAdapter(llmFactory, logger);
  const generateSummary = new GenerateSummary(
    summarisationAdapter,
    signalRepo,
    decisionsRepo,
    actionsRepo,
    summaryRepo,
    logger,
  );
  const catchMeUpCommand = new CatchMeUpCommand(summaryRepo, generateSummary, wireOutbound);
  const checkStaleness = new CheckStaleness(actionsRepo, wireOutbound, logger);
  const summaryPath = new SummaryRetrievalPath(summaryRepo, logger);

  const retrievalEngine = new MultiPathRetrievalEngine(structuredPath, semanticPath, graphPath, summaryPath, logger);

  const answerQuestion = new AnswerQuestion(
    generalAnswerAdapter,
    wireOutbound,
    queryAnalysis,
    retrievalEngine,
    logger,
  );

  const statusCommand = new StatusCommand(channelConfigRepo, entityRepo, wireOutbound);

  const logDecision = new LogDecision(decisionsRepo, wireOutbound, auditLogRepo, logger);
  const searchDecisions = new SearchDecisions(decisionsRepo, wireOutbound);
  const listDecisions = new ListDecisions(decisionsRepo, wireOutbound);
  const supersedeDecision = new SupersedeDecision(decisionsRepo, wireOutbound, auditLogRepo);
  const revokeDecision = new RevokeDecision(decisionsRepo, wireOutbound, auditLogRepo);

  const createActionFromExplicit = new CreateActionFromExplicit(
    actionsRepo,
    conversationConfigRepo,
    dateTimeService,
    userResolutionService,
    wireOutbound,
    auditLogRepo,
    logger,
  );
  const updateActionStatus = new UpdateActionStatus(actionsRepo, wireOutbound, auditLogRepo);
  const updateActionDeadline = new UpdateActionDeadline(actionsRepo, dateTimeService, wireOutbound, auditLogRepo);
  const listMyActions = new ListMyActions(actionsRepo, wireOutbound);
  const listTeamActions = new ListTeamActions(actionsRepo, wireOutbound);
  const listOverdueActions = new ListOverdueActions(actionsRepo, wireOutbound);
  const reassignAction = new ReassignAction(actionsRepo, userResolutionService, wireOutbound, auditLogRepo);

  const fireReminder = new FireReminder(remindersRepo, wireOutbound, auditLogRepo, systemActorId);
  const cancelReminder = new CancelReminder(remindersRepo, scheduler, wireOutbound, auditLogRepo);
  const snoozeReminder = new SnoozeReminder(remindersRepo, dateTimeService, scheduler, wireOutbound, auditLogRepo);
  const listMyReminders = new ListMyReminders(remindersRepo, wireOutbound);
  const createReminder = new CreateReminder(
    remindersRepo,
    dateTimeService,
    wireOutbound,
    scheduler,
    auditLogRepo,
    logger,
  );

  // Every branch uses .catch() so a single job failure never becomes an unhandled
  // rejection that crashes the process.
  scheduler.setHandler((job: ScheduledJob) => {
    if (job.type === "reminder" && typeof (job.payload as { reminderId?: string }).reminderId === "string") {
      const reminderId = (job.payload as { reminderId: string }).reminderId;
      void fireReminder.execute({ reminderId }).catch((err: unknown) => {
        logger.error("FireReminder job failed", { reminderId, err: String(err) });
      });
    }
    if (job.type === "secret_inactivity") {
      const convId = (job.payload as { convId: { id: string; domain: string } }).convId;
      void router.handleSecretModeInactivityCheck(convId).catch((err: unknown) => {
        logger.error("SecretInactivity job failed", { convId: convId.id, err: String(err) });
      });
    }
    if (job.type === "daily_summary_all") {
      const periodEnd = new Date();
      const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);
      void channelConfigRepo.listByState("active").then((channels) => {
        for (const ch of channels) {
          void generateSummary
            .execute({ channelId: ch.channelId, organisationId: ch.organisationId, granularity: "daily", periodStart, periodEnd })
            .catch((err: unknown) => logger.error("DailySummary job failed", { channelId: ch.channelId, err: String(err) }));
        }
      }).catch((err: unknown) => logger.error("DailySummary job failed to list channels", { err: String(err) }));
      scheduler.schedule({ id: "daily_summary_all", type: "daily_summary_all", runAt: nextDailyAt8UTC(), payload: {} });
    }
    if (job.type === "weekly_summary_all") {
      const periodEnd = new Date();
      const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
      void channelConfigRepo.listByState("active").then((channels) => {
        for (const ch of channels) {
          void generateSummary
            .execute({ channelId: ch.channelId, organisationId: ch.organisationId, granularity: "weekly", periodStart, periodEnd })
            .catch((err: unknown) => logger.error("WeeklySummary job failed", { channelId: ch.channelId, err: String(err) }));
        }
      }).catch((err: unknown) => logger.error("WeeklySummary job failed to list channels", { err: String(err) }));
      scheduler.schedule({ id: "weekly_summary_all", type: "weekly_summary_all", runAt: nextMondayAt8UTC(), payload: {} });
    }
    if (job.type === "staleness_check") {
      void checkStaleness.execute().catch((err: unknown) => {
        logger.error("StalenessCheck job failed", { err: String(err) });
      });
      const nextRun = new Date(Date.now() + 6 * 60 * 60 * 1000);
      scheduler.schedule({ id: "staleness_check", type: "staleness_check", runAt: nextRun, payload: {} });
    }
  });

  const router = new WireEventRouter({
    logger,
    botUserId: systemActorId,
    logDecision,
    searchDecisions,
    listDecisions,
    supersedeDecision,
    revokeDecision,
    createActionFromExplicit,
    updateActionStatus,
    reassignAction,
    updateActionDeadline,
    listMyActions,
    listTeamActions,
    listOverdueActions,
    createReminder,
    listMyReminders,
    cancelReminder,
    snoozeReminder,
    answerQuestion,
    statusCommand,
    catchMeUpCommand,
    wireOutbound,
    messageBuffer,
    dateTimeService,
    memberCache,
    scheduler,
    secretModeInactivityMs: config.app.secretModeInactivityMs,
    conversationConfig: conversationConfigRepo,
    channelConfig: channelConfigRepo,
    slidingWindow,
    processingQueue,
    pipeline,
    orgId: config.wire.userDomain,
  });
  handlerRef.current = router as unknown as HandlerManagerRef["current"];

  // Schedule recurring jobs (all self-reschedule after firing)
  scheduler.schedule({ id: "staleness_check",    type: "staleness_check",    runAt: new Date(Date.now() + 6 * 60 * 60 * 1000), payload: {} });
  scheduler.schedule({ id: "daily_summary_all",  type: "daily_summary_all",  runAt: nextDailyAt8UTC(),   payload: {} });
  scheduler.schedule({ id: "weekly_summary_all", type: "weekly_summary_all", runAt: nextMondayAt8UTC(),  payload: {} });

  let sdkPromise: Promise<WireAppSdk> | null = null;

  return {
    async getWireClient(): Promise<WireAppSdk> {
      if (!sdkPromise) {
        const storageDir = path.isAbsolute(config.app.storageDir)
          ? config.app.storageDir
          : path.join(process.cwd(), config.app.storageDir);
        if (!fs.existsSync(storageDir)) {
          fs.mkdirSync(storageDir, { recursive: true });
        }
        sdkPromise = createWireClient(config, router, path.join(storageDir, "apps.db")).then(async (sdk) => {
          // Rehydrate pending reminders only after the Wire SDK is fully initialised.
          // Scheduling before this point causes overdue reminders to fire before the
          // crypto client is ready, crashing with "Cannot read properties of undefined".
          void remindersRepo
            .query({ statusIn: ["pending"] })
            .then((pending) => {
              // Filter out reminders from e2e test conversations (domain "cli.local").
              // These have no real MLS group and would crash on send after rehydration.
              const testArtefacts = pending.filter((r) => r.conversationId?.domain === "cli.local");
              const real = pending.filter((r) => r.conversationId?.domain !== "cli.local");
              if (testArtefacts.length > 0) {
                logger.warn("Skipped rehydration of e2e test reminder artefacts", { count: testArtefacts.length });
              }
              for (const r of real) {
                scheduler.schedule({
                  id: `rem-${r.id}`,
                  type: "reminder",
                  runAt: r.triggerAt,
                  payload: { reminderId: r.id },
                });
              }
              if (real.length > 0) {
                logger.info("Rehydrated pending reminders from DB", { count: real.length });
              }
            })
            .catch((err: unknown) => {
              logger.error("Failed to rehydrate pending reminders", { err: String(err) });
            });

          // Hydrate the member cache from the SDK's persisted SQLite store before
          // startListening() is called. This ensures display names are available for
          // the first message after a restart (onAppAddedToConversation only fires on
          // first-ever join, not on reconnect).
          try {
            const [{ ConversationRepository }, { ConversationMemberRepository }, { container: sdkContainer }] =
              await Promise.all([
                import("wire-apps-js-sdk/build/db/ConversationRepository.js") as Promise<{ ConversationRepository: new (...a: unknown[]) => { getAll(): Array<{ id: string; domain: string }> } }>,
                import("wire-apps-js-sdk/build/db/ConversationMemberRepository.js") as Promise<{ ConversationMemberRepository: new (...a: unknown[]) => { getMembersByConversationId(id: string, domain: string): Array<{ user_id: string; user_domain: string; role: string }> } }>,
                import("tsyringe"),
              ]);
            const convRepo = sdkContainer.resolve(ConversationRepository);
            const memberRepo = sdkContainer.resolve(ConversationMemberRepository);
            const allConvs = convRepo.getAll();
            await router.hydrateFromSdkStore(allConvs, (conv) =>
              memberRepo.getMembersByConversationId(conv.id, conv.domain),
            );
            if (allConvs.length > 0) {
              logger.info("Member cache hydrated from SDK store", { conversations: allConvs.length });
            }
          } catch (err: unknown) {
            logger.error("Failed to hydrate member cache from SDK store", { err: String(err) });
          }

          return sdk;
        });
      }
      return sdkPromise;
    },
    async shutdown(): Promise<void> {
      await getPrismaClient().$disconnect();
    },
  };
}

/** Returns the next 08:00 UTC today (or tomorrow if already past 08:00). */
function nextDailyAt8UTC(): Date {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Returns the next Monday at 08:00 UTC. */
function nextMondayAt8UTC(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 8, 0, 0, 0));
  return next;
}
