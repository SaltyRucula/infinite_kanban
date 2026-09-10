import type { Task, AgentEvent } from '../types.js';

export interface TaskRepository {
  getAll(includeArchived?: boolean, projectId?: string): Promise<Task[]>;
  getById(id: string): Promise<Task | undefined>;
  getByExternalIdentity(projectId: string, source: string, key: string): Promise<Task | undefined>;
  create(task: Task): Promise<Task>;
  createIdempotent(task: Task): Promise<{ task: Task; created: boolean }>;
  requestRun(id: string, requestedAt: number): Promise<Task | undefined>;
  claimRun(id: string, claimedAt: number): Promise<Task | undefined>;
  clearRun(id: string): Promise<Task | undefined>;
  getPendingRuns(staleBefore?: number): Promise<Task[]>;
  assignToWorker(id: string, workerId: string | null): Promise<Task | undefined>;
  getWorkerAssignments(workerId: string, now: number): Promise<Task[]>;
  claimWorkerTask(id: string, workerId: string, claimTokenHash: string, now: number, leaseMs: number): Promise<Task | undefined>;
  renewWorkerLease(id: string, workerId: string, claimTokenHash: string, now: number, leaseMs: number): Promise<boolean>;
  isWorkerClaimValid(id: string, workerId: string, claimTokenHash: string, now: number): Promise<boolean>;
  completeWorkerTask(id: string, workerId: string, claimTokenHash: string, status: 'complete' | 'failed', completedAt: number, summary?: string, error?: string): Promise<Task | undefined>;
  getExpiredWorkerTasks(now: number): Promise<Task[]>;
  getAssignedWorkerTasks(workerIds: readonly string[]): Promise<Task[]>;
  update(id: string, updates: Partial<Task>): Promise<Task | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  insertEvent(event: AgentEvent): Promise<void>;
  getEventsByTaskId(taskId: string): Promise<AgentEvent[]>;
  deleteEventsByTaskId(taskId: string): Promise<void>;
  getArchivedTasks(projectId?: string): Promise<Task[]>;
}
