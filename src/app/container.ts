import "reflect-metadata";
import fs from "fs";
import path from "node:path";
import type { WireAppSdk } from "wire-apps-js-sdk";
import type { Config } from "./config";
import type { Logger } from "./logging";
import { createWireOutboundAdapter, type HandlerManagerRef } from "../infrastructure/wire/WireOutboundAdapter";
import { WireEventRouter } from "../infrastructure/wire/WireEventRouter";
import { createWireClient } from "../infrastructure/wire/WireClient";
import { PrismaTaskRepository } from "../infrastructure/persistence/postgres/PrismaTaskRepository";
import { PrismaDecisionRepository } from "../infrastructure/persistence/postgres/PrismaDecisionRepository";
import { PrismaActionRepository } from "../infrastructure/persistence/postgres/PrismaActionRepository";
import { PrismaReminderRepository } from "../infrastructure/persistence/postgres/PrismaReminderRepository";
import { PrismaConversationConfigRepository } from "../infrastructure/persistence/postgres/PrismaConversationConfigRepository";
import { PrismaKnowledgeRepository } from "../infrastructure/persistence/postgres/PrismaKnowledgeRepository";
import { PrismaAuditLogRepository } from "../infrastructure/persistence/postgres/PrismaAuditLogRepository";
import { PrismaSearchAdapter } from "../infrastructure/search/PrismaSearchAdapter";
import { SystemDateTimeService } from "../infrastructure/services/SystemDateTimeService";
import { MemberCacheUserResolutionService } from "../infrastructure/services/MemberCacheUserResolutionService";
import { InMemoryMemberCache } from "../infrastructure/services/InMemoryMemberCache";
import { InProcessScheduler } from "../infrastructure/scheduler/InProcessScheduler";
import { ConversationMessageBuffer } from "../application/services/ConversationMessageBuffer";
import { CreateTaskFromExplicit } from "../application/usecases/tasks/CreateTaskFromExplicit";
import { UpdateTaskStatus } from "../application/usecases/tasks/UpdateTaskStatus";
import { ListMyTasks } from "../application/usecases/tasks/ListMyTasks";
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
import { CreateReminder } from "../application/usecases/reminders/CreateReminder";
import { ListMyReminders } from "../application/usecases/reminders/ListMyReminders";
import { OverdueNudgeService } from "../application/services/OverdueNudgeService";
import { WeeklyDigestService } from "../application/services/WeeklyDigestService";
import { FireReminder } from "../application/usecases/reminders/FireReminder";
import type { ScheduledJob } from "../application/ports/SchedulerPort";
import { getPrismaClient } from "../infrastructure/persistence/postgres/PrismaClient";
import { getPassiveLLMConfig, getCapableLLMConfig, getEmbeddingConfig } from "../infrastructure/llm/LLMConfigAdapter";
import { OpenAIEmbeddingAdapter } from "../infrastructure/llm/OpenAIEmbeddingAdapter";
import { BackfillEmbeddings } from "../application/usecases/knowledge/BackfillEmbeddings";
import { StoreKnowledge } from "../application/usecases/knowledge/StoreKnowledge";
import { RetrieveKnowledge } from "../application/usecases/knowledge/RetrieveKnowledge";
import { ListKnowledge } from "../application/usecases/knowledge/ListKnowledge";
import { DeleteKnowledge } from "../application/usecases/knowledge/DeleteKnowledge";
import { UpdateKnowledge } from "../application/usecases/knowledge/UpdateKnowledge";
import { CheckKnowledgeStaleness } from "../application/usecases/knowledge/CheckKnowledgeStaleness";
import { UpdateTask } from "../application/usecases/tasks/UpdateTask";
import { ReassignTask } from "../application/usecases/tasks/ReassignTask";
import { UpdateTaskDeadline } from "../application/usecases/tasks/UpdateTaskDeadline";
import { ListTeamTasks } from "../application/usecases/tasks/ListTeamTasks";
import { UpdateAction } from "../application/usecases/actions/UpdateAction";
import { UpdateActionDeadline } from "../application/usecases/actions/UpdateActionDeadline";
import { ListOverdueActions } from "../application/usecases/actions/ListOverdueActions";
import { CancelReminder } from "../application/usecases/reminders/CancelReminder";
import { SnoozeReminder } from "../application/usecases/reminders/SnoozeReminder";
import { OpenAIConversationIntelligenceAdapter } from "../infrastructure/llm/OpenAIConversationIntelligenceAdapter";
import { StubConversationIntelligenceAdapter } from "../infrastructure/llm/StubConversationIntelligenceAdapter";
import { OpenAIGeneralAnswerAdapter } from "../infrastructure/llm/OpenAIGeneralAnswerAdapter";
import { AnswerQuestion } from "../application/usecases/general/AnswerQuestion";

export interface Container {
  getWireClient(): Promise<WireAppSdk>;
  shutdown(): Promise<void>;
}

export function createContainer(config: Config, logger: Logger): Container {
  const handlerRef: HandlerManagerRef = { current: null };

  const wireOutbound = createWireOutboundAdapter(handlerRef, logger);

  const tasksRepo = new PrismaTaskRepository();
  const decisionsRepo = new PrismaDecisionRepository();
  const actionsRepo = new PrismaActionRepository();
  const remindersRepo = new PrismaReminderRepository();
  const knowledgeRepo = new PrismaKnowledgeRepository();
  const conversationConfigRepo = new PrismaConversationConfigRepository();
  const auditLogRepo = new PrismaAuditLogRepository();
  const systemActorId = { id: config.wire.userId, domain: config.wire.userDomain };
  const dateTimeService = new SystemDateTimeService();
  const memberCache = new InMemoryMemberCache();
  const userResolutionService = new MemberCacheUserResolutionService(memberCache);
  const messageBuffer = new ConversationMessageBuffer(config.app.messageBufferSize);
  const scheduler = new InProcessScheduler(logger);

  const passiveLlmConfig = getPassiveLLMConfig(config);
  const capableLlmConfig = getCapableLLMConfig(config);
  const embeddingConfig = getEmbeddingConfig(config);
  const intelligenceLlmConfig = passiveLlmConfig.enabled ? passiveLlmConfig : capableLlmConfig;
  const conversationIntelligence = intelligenceLlmConfig.enabled
    ? new OpenAIConversationIntelligenceAdapter(intelligenceLlmConfig, logger)
    : new StubConversationIntelligenceAdapter(logger);
  const embeddingAdapter = embeddingConfig.enabled ? new OpenAIEmbeddingAdapter(embeddingConfig, logger) : undefined;
  const searchService = new PrismaSearchAdapter(knowledgeRepo, embeddingAdapter);
  const generalAnswerAdapter = new OpenAIGeneralAnswerAdapter(capableLlmConfig, logger);
  const answerQuestion = new AnswerQuestion(generalAnswerAdapter, wireOutbound, searchService, knowledgeRepo);
  const storeKnowledge = new StoreKnowledge(knowledgeRepo, wireOutbound, auditLogRepo, logger, embeddingAdapter);
  const retrieveKnowledge = new RetrieveKnowledge(searchService, knowledgeRepo, wireOutbound);
  const listKnowledge = new ListKnowledge(knowledgeRepo, wireOutbound);
  const deleteKnowledge = new DeleteKnowledge(knowledgeRepo, wireOutbound, auditLogRepo);
  const updateKnowledge = new UpdateKnowledge(knowledgeRepo, wireOutbound, auditLogRepo);
  const checkKnowledgeStaleness = new CheckKnowledgeStaleness(knowledgeRepo, wireOutbound);
  const backfillEmbeddings = embeddingAdapter
    ? new BackfillEmbeddings(knowledgeRepo, embeddingAdapter, logger)
    : null;

  const createTaskFromExplicit = new CreateTaskFromExplicit(
    tasksRepo,
    conversationConfigRepo,
    dateTimeService,
    userResolutionService,
    wireOutbound,
    auditLogRepo,
    logger,
  );
  const updateTaskStatus = new UpdateTaskStatus(tasksRepo, wireOutbound, auditLogRepo);
  const updateTask = new UpdateTask(tasksRepo, conversationConfigRepo, dateTimeService, userResolutionService, wireOutbound, auditLogRepo);
  const reassignTask = new ReassignTask(tasksRepo, userResolutionService, wireOutbound, auditLogRepo);
  const updateTaskDeadline = new UpdateTaskDeadline(tasksRepo, dateTimeService, wireOutbound, auditLogRepo);
  const listMyTasks = new ListMyTasks(tasksRepo, wireOutbound);
  const listTeamTasks = new ListTeamTasks(tasksRepo, wireOutbound);
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
  const updateAction = new UpdateAction(actionsRepo, conversationConfigRepo, dateTimeService, userResolutionService, wireOutbound, auditLogRepo);
  const updateActionDeadline = new UpdateActionDeadline(actionsRepo, dateTimeService, wireOutbound, auditLogRepo);
  const listMyActions = new ListMyActions(actionsRepo, wireOutbound);
  const listTeamActions = new ListTeamActions(actionsRepo, wireOutbound);
  const listOverdueActions = new ListOverdueActions(actionsRepo, wireOutbound);
  const reassignAction = new ReassignAction(actionsRepo, userResolutionService, wireOutbound, auditLogRepo);
  const fireReminder = new FireReminder(remindersRepo, wireOutbound, auditLogRepo, systemActorId);
  const overdueNudgeService = new OverdueNudgeService(actionsRepo, wireOutbound);
  const weeklyDigestService = new WeeklyDigestService(
    tasksRepo,
    actionsRepo,
    decisionsRepo,
    wireOutbound,
  );
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

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const ONE_WEEK_MS = 7 * ONE_DAY_MS;

  scheduler.setHandler((job: ScheduledJob) => {
    if (job.type === "reminder" && typeof (job.payload as { reminderId?: string }).reminderId === "string") {
      void fireReminder.execute({ reminderId: (job.payload as { reminderId: string }).reminderId });
    }
    if (job.type === "overdue_nudge") {
      void overdueNudgeService.run().then(() => {
        scheduler.schedule({
          id: "overdue_nudge",
          type: "overdue_nudge",
          runAt: new Date(Date.now() + ONE_DAY_MS),
          payload: {},
        });
      });
    }
    if (job.type === "weekly_digest") {
      void weeklyDigestService.run().then(() => {
        scheduler.schedule({
          id: "weekly_digest",
          type: "weekly_digest",
          runAt: new Date(Date.now() + ONE_WEEK_MS),
          payload: {},
        });
      });
    }
    if (job.type === "knowledge_staleness") {
      void checkKnowledgeStaleness.run().then(() => {
        scheduler.schedule({
          id: "knowledge_staleness",
          type: "knowledge_staleness",
          runAt: new Date(Date.now() + ONE_DAY_MS),
          payload: {},
        });
      });
    }
    if (job.type === "secret_inactivity") {
      const convId = (job.payload as { convId: { id: string; domain: string } }).convId;
      void router.handleSecretModeInactivityCheck(convId);
    }
    if (job.type === "embedding_backfill" && backfillEmbeddings) {
      void backfillEmbeddings.run();
    }
  });

  scheduler.schedule({
    id: "overdue_nudge",
    type: "overdue_nudge",
    runAt: new Date(Date.now() + ONE_DAY_MS),
    payload: {},
  });
  scheduler.schedule({
    id: "weekly_digest",
    type: "weekly_digest",
    runAt: new Date(Date.now() + ONE_WEEK_MS),
    payload: {},
  });
  scheduler.schedule({
    id: "knowledge_staleness",
    type: "knowledge_staleness",
    runAt: new Date(Date.now() + ONE_DAY_MS),
    payload: {},
  });

  // Run embedding backfill shortly after startup to embed any pre-existing entries.
  if (backfillEmbeddings) {
    scheduler.schedule({
      id: "embedding_backfill",
      type: "embedding_backfill",
      runAt: new Date(Date.now() + 5_000),
      payload: {},
    });
  }


  const router = new WireEventRouter({
    logger,
    botUserId: systemActorId,
    createTaskFromExplicit,
    updateTaskStatus,
    updateTask,
    reassignTask,
    updateTaskDeadline,
    listMyTasks,
    listTeamTasks,
    logDecision,
    searchDecisions,
    listDecisions,
    supersedeDecision,
    revokeDecision,
    createActionFromExplicit,
    updateActionStatus,
    updateAction,
    reassignAction,
    updateActionDeadline,
    listMyActions,
    listTeamActions,
    listOverdueActions,
    createReminder,
    listMyReminders,
    cancelReminder,
    snoozeReminder,
    storeKnowledge,
    retrieveKnowledge,
    listKnowledge,
    deleteKnowledge,
    updateKnowledge,
    answerQuestion,
    conversationIntelligence,
    wireOutbound,
    messageBuffer,
    dateTimeService,
    memberCache,
    scheduler,
    secretModeInactivityMs: config.app.secretModeInactivityMs,
    conversationConfig: conversationConfigRepo,
  });
  handlerRef.current = router as HandlerManagerRef["current"];

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
        sdkPromise = createWireClient(config, router, path.join(storageDir, "apps.db")).then((sdk) => {
          // Rehydrate pending reminders only after the Wire SDK is fully initialised.
          // Scheduling before this point causes overdue reminders to fire before the
          // crypto client is ready, crashing with "Cannot read properties of undefined".
          void remindersRepo
            .query({ statusIn: ["pending"] })
            .then((pending) => {
              for (const r of pending) {
                scheduler.schedule({
                  id: `rem-${r.id}`,
                  type: "reminder",
                  runAt: r.triggerAt,
                  payload: { reminderId: r.id },
                });
              }
              if (pending.length > 0) {
                logger.info("Rehydrated pending reminders from DB", { count: pending.length });
              }
            })
            .catch((err: unknown) => {
              logger.error("Failed to rehydrate pending reminders", { err: String(err) });
            });
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
