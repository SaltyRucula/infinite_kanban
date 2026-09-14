import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { createWSS } from './websocket.js';
import { initDatabase, initPostgresDatabase, isPostgresUrl } from './db.js';
import { loadConfig } from './config.js';
import { SqliteTaskRepository } from './repositories/sqlite.js';
import { PostgresTaskRepository } from './repositories/postgres.js';
import { createTaskRouter } from './routes/tasks.js';
import { createAgentRouter } from './routes/agent.js';
import { createGitRouter } from './routes/git.js';
import { createTemplateRouter } from './routes/templates.js';
import { createGroupsRouter } from './routes/groups.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createProjectsRouter } from './routes/projects.js';
import { createOrchestrationsRouter } from './routes/orchestrations.js';
import { createJiraRouter } from './routes/jira.js';
import { JiraImportExecutionService } from './jira/import-execution.js';
import { JiraImportScheduler } from './jira/import-scheduler.js';
import { OpenCodeJiraRepositoryRouter } from './jira/repository-router.js';
import type { AttachmentStore } from './repositories/attachment-types.js';
import { AgentManager } from './services/agent-manager.js';
import { authMiddleware } from './middleware/auth.js';
import type { TaskRepository } from './repositories/types.js';
import type { TemplateRepository } from './repositories/template-types.js';
import type { TaskGroupRepository } from './repositories/group-types.js';
import type { ProjectRepository } from './repositories/project-types.js';
import { startAgentForTask } from './routes/helpers.js';
import { isLoopbackAddress } from './network-policy.js';
import { createDurableRunRequestedCallback, dispatchPendingRuns } from './run-dispatcher.js';
import { SqliteWorkerRepository } from './repositories/sqlite-workers.js';
import { PostgresWorkerRepository } from './repositories/postgres-workers.js';
import type { WorkerRepository } from './repositories/worker-types.js';
import { createWorkersRouter } from './routes/workers.js';
import { broadcastTaskUpdate, broadcastWorkerUpdate } from './routes/helpers.js';
import { WORKER_HEARTBEAT_INTERVAL_MS, WORKER_STALE_AFTER_MS } from '@ai-agent-board/shared/constants.js';
import {
  shouldRecoverGroupChildAsFailed,
  shouldRecoverGroupChildToIdle,
  shouldRecoverStandaloneTaskAsFailed,
  getAllTasksAcrossProjects,
  getAllGroupsAcrossProjects,
} from './startup-recovery.js';
import {
  registerE2EClarificationProvider,
  shouldRegisterE2EClarificationProvider,
} from './services/e2e-clarification-provider-gate.js';

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST?.trim() || '127.0.0.1';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8081,http://localhost:4175,http://localhost:4176').split(',');
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '100kb' }));

// API key auth — when API_KEY env var is set, all /api routes require
// Authorization: Bearer *** When unset, auth is skipped (local dev).
app.use('/api', authMiddleware);

const DATABASE_URL = process.env.DATABASE_URL;

let taskRepo: TaskRepository;
let templateRepo: TemplateRepository;
let groupRepo: TaskGroupRepository;
let projectRepo: ProjectRepository;
let attachmentStore: AttachmentStore;
let workerRepo: WorkerRepository;
let cleanupDb: () => void;
let jiraImportScheduler: JiraImportScheduler | undefined;

// Initialize AgentManager
const agentManager = new AgentManager();

(async () => {
  // Load (and create on first run) the Agent Board config + clone root directory.
  const config = loadConfig();
  console.log(`[server] clone root: ${config.cloneRoot}`);

  if (isPostgresUrl(DATABASE_URL)) {
    // PostgreSQL backend
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: DATABASE_URL });
    await initPostgresDatabase(pool);
    taskRepo = new PostgresTaskRepository(pool);
    workerRepo = new PostgresWorkerRepository(pool);
    const { PostgresProjectRepository } = await import('./repositories/postgres-projects.js');
    projectRepo = new PostgresProjectRepository(pool);
    const { PostgresTemplateRepository } = await import('./repositories/postgres-templates.js');
    templateRepo = new PostgresTemplateRepository(pool);
    const { PostgresTaskGroupRepository } = await import('./repositories/postgres-groups.js');
    groupRepo = new PostgresTaskGroupRepository(pool);
    const { PostgresAttachmentStore } = await import('./repositories/postgres-attachments.js');
    attachmentStore = new PostgresAttachmentStore(pool);
    cleanupDb = () => { pool.end(); };
    console.log('[server] using PostgreSQL backend');
  } else {
    // SQLite fallback
    const db = initDatabase();
    taskRepo = new SqliteTaskRepository(db);
    workerRepo = new SqliteWorkerRepository(db);
    const { SqliteProjectRepository } = await import('./repositories/sqlite-projects.js');
    projectRepo = new SqliteProjectRepository(db);
    const { SqliteTemplateRepository } = await import('./repositories/sqlite-templates.js');
    templateRepo = new SqliteTemplateRepository(db);
    const { SqliteTaskGroupRepository } = await import('./repositories/sqlite-groups.js');
    groupRepo = new SqliteTaskGroupRepository(db);
    const { SqliteAttachmentStore } = await import('./repositories/sqlite-attachments.js');
    attachmentStore = new SqliteAttachmentStore(db);
    cleanupDb = () => { db.close(); };
    console.log('[server] using SQLite backend');
  }

  agentManager.initEventPersistence(taskRepo);
  agentManager.initAttachmentStore(attachmentStore);

  const dispatchPendingDurableRuns = async (staleBefore?: number): Promise<void> => {
    await dispatchPendingRuns(
      {
        taskRepo,
        isTaskRunning: (taskId) => agentManager.isRunning(taskId),
        dispatchTask: (task) => startAgentForTask(task, taskRepo, agentManager),
      },
      { staleBefore },
    );
  };

    const jiraImportExecutor = new JiraImportExecutionService({
      taskRepo,
      projectRepo,
      listRoutingProjects: () => projectRepo.getAllWithCounts(),
      repositoryRouter: new OpenCodeJiraRepositoryRouter(),
      listAvailableAgents: () => agentManager.getAvailableAgents(),
    onDurableRunRequested: createDurableRunRequestedCallback({
      dispatchPendingRuns: dispatchPendingDurableRuns,
      requestSchedulerTick: () => jiraImportScheduler?.requestTick(),
    }),
  });
  jiraImportScheduler = new JiraImportScheduler({
    projectRepo,
    taskRepo,
    importExecutor: jiraImportExecutor,
  });

  app.use('/api/projects', createProjectsRouter(projectRepo, taskRepo, groupRepo, agentManager, () => jiraImportScheduler?.requestTick()));
  app.use('/api/orchestrations', createOrchestrationsRouter(taskRepo, projectRepo, agentManager));
  app.use('/api/jira', createJiraRouter(projectRepo, jiraImportExecutor));
  app.use('/api/tasks', createTaskRouter(taskRepo, agentManager, projectRepo));
  app.use('/api/tasks', createAgentRouter(taskRepo, agentManager, groupRepo, projectRepo, workerRepo));
  app.use('/api/tasks', createGitRouter(taskRepo, agentManager));
  app.use('/api/workers', createWorkersRouter(taskRepo, workerRepo));
  app.post('/api/tasks/:id/assign', async (req, res, next) => {
    try {
      const task = await taskRepo.getById(String(req.params.id));
      if (!task) { res.status(404).json({ error: 'task not found' }); return; }
      const workerId = req.body.workerId ?? req.body.assignedWorkerId ?? null;
      if (workerId !== null && typeof workerId !== 'string') { res.status(400).json({ error: 'workerId must be a string or null' }); return; }
      if (workerId !== null && !await workerRepo.getById(workerId)) { res.status(404).json({ error: 'worker not found' }); return; }
      if (task.agentStatus === 'planning' || task.agentStatus === 'executing') { res.status(409).json({ error: 'cannot assign a running task' }); return; }
      const updated = await taskRepo.assignToWorker(task.id, workerId);
      if (!updated) { res.status(409).json({ error: 'task is already claimed or not eligible' }); return; }
      broadcastTaskUpdate(updated);
      res.json(updated);
    } catch (err) { next(err); }
  });
  app.use('/api/templates', createTemplateRouter(templateRepo));
  app.use('/api/groups', createGroupsRouter(groupRepo, taskRepo, agentManager, projectRepo));
  app.use('/api', createAttachmentsRouter(taskRepo, attachmentStore));

  // GET /api/agents — list available agents
  app.get('/api/agents', (_req, res) => { res.json(agentManager.getAvailableAgents()); });
  app.post('/api/agents/refresh', async (_req, res, next) => { try { res.json(await agentManager.refresh()); } catch (err) { next(err); } });

  // Health check (no auth required)
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Global error handler — catches errors forwarded by asyncHandler wrappers
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] unhandled route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  const server = createServer(app);
  createWSS(server);

  await agentManager.initialize();

  if (shouldRegisterE2EClarificationProvider(process.env)) {
    registerE2EClarificationProvider(agentManager);
  }


  // Recover orphaned task groups first — group children get group-aware
  // recovery (planning → idle for re-queue, executing → failed) before the
  // generic fallback below resets everything to failed.
  const groupChildIds = new Set<string>();
  try {
    const allGroups = await getAllGroupsAcrossProjects(projectRepo, groupRepo);
    for (const group of allGroups) {
      if (group.columnId === 'in-progress') {
        const children = await groupRepo.getChildTasks(group.id);
        for (const child of children) {
          groupChildIds.add(child.id);
          if (shouldRecoverGroupChildAsFailed(child.agentStatus)) {
            await taskRepo.update(child.id, { agentStatus: 'failed', completedAt: Date.now() });
            await taskRepo.clearRun(child.id);
            await workerRepo.clearTaskSessions(child.id);
            console.warn(`[server] recovered orphaned group child ${child.id} "${child.title}" (was ${child.agentStatus})`);
          } else if (shouldRecoverGroupChildToIdle(child.agentStatus)) {
            // Planning children hadn't started — reset to idle so they can be re-queued
            await taskRepo.update(child.id, { agentStatus: 'idle', startedAt: undefined });
            await workerRepo.clearTaskSessions(child.id);
            console.warn(`[server] reset group child ${child.id} "${child.title}" (was planning → idle)`);
          }
        }
        // Check if group should auto-advance after recovery
        const updatedChildren = await groupRepo.getChildTasks(group.id);
        const allDone = updatedChildren.every(c => c.agentStatus === 'complete' || c.agentStatus === 'failed');
        const anyFailed = updatedChildren.some(c => c.agentStatus === 'failed');
        if (allDone && !anyFailed) {
          await groupRepo.update(group.id, { columnId: 'review', completedAt: Date.now() });
          console.warn(`[server] recovered group ${group.id} "${group.title}" → review`);
        }
      }
    }
  } catch (err) {
    console.error('[server] failed to recover groups:', err);
  }

  // Re-dispatch durable requests left unclaimed by a crash.
  const recoveredRunIds = new Set<string>();
  await dispatchPendingRuns(
    {
      taskRepo,
      isTaskRunning: (taskId) => agentManager.isRunning(taskId),
      dispatchTask: async (task) => {
        console.warn(`[server] recovering requested run ${task.id}`);
        recoveredRunIds.add(task.id);
        await startAgentForTask(task, taskRepo, agentManager);
      },
    },
    { staleBefore: Date.now() },
  );

  // Recover standalone tasks orphaned by a previous server restart.
  // Skip group children (already handled above with group-aware recovery).
  const allTasks = await getAllTasksAcrossProjects(projectRepo, taskRepo);
  const orphaned = allTasks.filter((t) => shouldRecoverStandaloneTaskAsFailed(t.agentStatus) && !groupChildIds.has(t.id) && !recoveredRunIds.has(t.id));
  for (const task of orphaned) {
    await taskRepo.update(task.id, {
      agentStatus: 'failed',
      completedAt: Date.now(),
    });
    await taskRepo.clearRun(task.id);
    await workerRepo.clearTaskSessions(task.id);
    console.warn(`[server] recovered orphaned task ${task.id} "${task.title}" (was ${task.agentStatus})`);
  }

  // Reclaim stale dispatch leases continuously, not only after a restart.
  const dispatchInterval = setInterval(() => {
    void dispatchPendingDurableRuns().catch((err) => console.error('[server] dispatch recovery failed:', err));
  }, 15_000);
  dispatchInterval.unref();

  const workerSweepInterval = setInterval(async () => {
    const now = Date.now();
    const offline = await workerRepo.markOffline(now - WORKER_STALE_AFTER_MS, now);
    for (const worker of offline) {
      broadcastWorkerUpdate(worker);
      const tasks = await taskRepo.getAssignedWorkerTasks([worker.id]);
      for (const task of tasks) {
        const failed = await taskRepo.update(task.id, { agentStatus: 'failed', completedAt: now, summary: 'worker_offline', runClaimedAt: undefined });
        if (failed) {
          await workerRepo.clearTaskSessions(task.id);
          await workerRepo.clearTaskCommands(task.id);
          broadcastTaskUpdate(failed);
        }
      }
    }
    const expired = await taskRepo.getExpiredWorkerTasks(now);
    for (const task of expired) {
      const failed = await taskRepo.update(task.id, { agentStatus: 'failed', completedAt: now, summary: 'worker_offline', runClaimedAt: undefined });
      if (failed) {
        await workerRepo.clearTaskSessions(task.id);
        await workerRepo.clearTaskCommands(task.id);
        broadcastTaskUpdate(failed);
      }
    }
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  workerSweepInterval.unref();

  server.listen(PORT, HOST, () => {
    jiraImportScheduler?.start();
    console.log(`[server] listening on http://${HOST}:${PORT}`);
    console.log(`[server] WebSocket at ws://${HOST}:${PORT}/ws`);
    if (process.env.API_KEY) {
      console.log('[server] API key authentication enabled');
    } else {
      console.warn('[server] WARNING: No API_KEY set — all endpoints are open without authentication.');
      console.warn('[server] Set the API_KEY environment variable to enable authentication.');
      if (!isLoopbackAddress(server.address())) {
        console.warn('[server] WARNING: effective bind address is not loopback while API_KEY is unset.');
      }
    }
  });

  // Graceful shutdown
  function shutdown() {
    console.log('[server] shutting down...');
    clearInterval(dispatchInterval);
    clearInterval(workerSweepInterval);
    jiraImportScheduler?.stop();
    agentManager.shutdownAll();
    const closePromise = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    const forceExitTimer = setTimeout(() => {
      console.warn('[server] force exit after timeout');
      process.exit(1);
    }, 5_000);
    forceExitTimer.unref();

    void (async () => {
      try {
        if (jiraImportScheduler) {
          const schedulerDrained = await jiraImportScheduler.awaitIdle(4_800);
          if (!schedulerDrained) {
            console.warn('[server] jira import scheduler did not drain before shutdown deadline');
          }
        }
      } catch (err) {
        console.warn('[server] jira scheduler shutdown error:', err);
      }

      try { cleanupDb(); } catch (err) { console.error('[server] db cleanup error:', err); }
      await closePromise;
      clearTimeout(forceExitTimer);
      process.exit(0);
    })();
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})();
