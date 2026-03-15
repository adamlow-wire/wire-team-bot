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
import { OverdueNudgeService } from "../application/services/OverdueNudgeService";
import { WeeklyDigestService } from "../application/services/WeeklyDigestService";
import { FireReminder } from "../application/usecases/reminders/FireReminder";
import type { ScheduledJob } from "../application/ports/SchedulerPort";
import { getPrismaClient } from "../infrastructure/persistence/postgres/PrismaClient";
import { getLLMConfig } from "../infrastructure/llm/LLMConfigAdapter";
import { StubImplicitDetectionAdapter } from "../infrastructure/llm/StubImplicitDetectionAdapter";
import { OpenAIImplicitDetectionAdapter } from "../infrastructure/llm/OpenAIImplicitDetectionAdapter";
import { StoreKnowledge } from "../application/usecases/knowledge/StoreKnowledge";
import { RetrieveKnowledge } from "../application/usecases/knowledge/RetrieveKnowledge";
import { CheckKnowledgeStaleness } from "../application/usecases/knowledge/CheckKnowledgeStaleness";

export interface Container {
  getWireClient(): Promise<WireAppSdk>;
  shutdown(): Promise<void>;
}

export function createContainer(config: Config, logger: Logger): Container {
  const handlerRef: HandlerManagerRef = { current: null };

  const wireOutbound = createWireOutboundAdapter(handlerRef);

  const tasksRepo = new PrismaTaskRepository();
  const decisionsRepo = new PrismaDecisionRepository();
  const actionsRepo = new PrismaActionRepository();
  const remindersRepo = new PrismaReminderRepository();
  const knowledgeRepo = new PrismaKnowledgeRepository();
  const conversationConfigRepo = new PrismaConversationConfigRepository();
  const auditLogRepo = new PrismaAuditLogRepository();
  const searchService = new PrismaSearchAdapter(knowledgeRepo);
  const systemActorId = { id: config.wire.userId, domain: config.wire.userDomain };
  const dateTimeService = new SystemDateTimeService();
  const memberCache = new InMemoryMemberCache();
  const userResolutionService = new MemberCacheUserResolutionService(memberCache);
  const messageBuffer = new ConversationMessageBuffer(config.app.messageBufferSize);
  const scheduler = new InProcessScheduler();

  const llmConfig = getLLMConfig(config);
  const implicitDetection = llmConfig.enabled
    ? new OpenAIImplicitDetectionAdapter(llmConfig)
    : new StubImplicitDetectionAdapter(llmConfig);
  const storeKnowledge = new StoreKnowledge(knowledgeRepo, wireOutbound, auditLogRepo);
  const retrieveKnowledge = new RetrieveKnowledge(searchService, knowledgeRepo, wireOutbound);
  const checkKnowledgeStaleness = new CheckKnowledgeStaleness(knowledgeRepo, wireOutbound);

  const createTaskFromExplicit = new CreateTaskFromExplicit(
    tasksRepo,
    conversationConfigRepo,
    dateTimeService,
    userResolutionService,
    wireOutbound,
    auditLogRepo,
  );
  const updateTaskStatus = new UpdateTaskStatus(tasksRepo, wireOutbound, auditLogRepo);
  const listMyTasks = new ListMyTasks(tasksRepo, wireOutbound);
  const logDecision = new LogDecision(decisionsRepo, wireOutbound, auditLogRepo);
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
  );
  const updateActionStatus = new UpdateActionStatus(actionsRepo, wireOutbound, auditLogRepo);
  const listMyActions = new ListMyActions(actionsRepo, wireOutbound);
  const listTeamActions = new ListTeamActions(actionsRepo, wireOutbound);
  const reassignAction = new ReassignAction(actionsRepo, userResolutionService, wireOutbound, auditLogRepo);
  const fireReminder = new FireReminder(remindersRepo, wireOutbound, auditLogRepo, systemActorId);
  const overdueNudgeService = new OverdueNudgeService(actionsRepo, wireOutbound);
  const weeklyDigestService = new WeeklyDigestService(
    tasksRepo,
    actionsRepo,
    decisionsRepo,
    wireOutbound,
  );
  const createReminder = new CreateReminder(
    remindersRepo,
    dateTimeService,
    wireOutbound,
    scheduler,
    auditLogRepo,
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

  // Rehydrate pending reminders that survived a restart. Fire immediately any
  // that are already overdue; schedule future ones normally.
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

  const router = new WireEventRouter({
    logger,
    createTaskFromExplicit,
    updateTaskStatus,
    listMyTasks,
    logDecision,
    searchDecisions,
    listDecisions,
    supersedeDecision,
    revokeDecision,
    createActionFromExplicit,
    updateActionStatus,
    listMyActions,
    listTeamActions,
    reassignAction,
    createReminder,
    storeKnowledge,
    retrieveKnowledge,
    implicitDetection,
    wireOutbound,
    messageBuffer,
    dateTimeService,
    memberCache,
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
        sdkPromise = createWireClient(config, router, path.join(storageDir, "apps.db"));
      }
      return sdkPromise;
    },
    async shutdown(): Promise<void> {
      await getPrismaClient().$disconnect();
    },
  };
}
