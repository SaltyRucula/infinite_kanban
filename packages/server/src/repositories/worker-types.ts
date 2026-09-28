import type { AgentType, Worker } from '../types.js';

export interface WorkerRegistration {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly agentTypes: readonly AgentType[];
  readonly maxConcurrentTasks: number;
  readonly hostname?: string;
  readonly version?: string;
  readonly registeredAt: number;
}

export type WorkerTaskCommand = {
  readonly id: string;
  readonly type: 'message' | 'clarification' | 'cancel';
  readonly createdAt: number;
  readonly message?: string;
  readonly attachmentIds?: readonly string[];
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly answer?: string;
};

export type RegisteredWorkerOpenCodeSession = {
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly updatedAt: number;
};

export interface WorkerRepository {
  register(input: WorkerRegistration): Promise<Worker>;
  heartbeat(id: string, at: number): Promise<Worker | undefined>;
  getById(id: string): Promise<Worker | undefined>;
  getByTokenHash(tokenHash: string): Promise<(Worker & { readonly tokenHash: string; readonly tokenIssuedAt?: number }) | undefined>;
  list(): Promise<Worker[]>;
  setStatus(id: string, status: 'online' | 'disabled', at: number): Promise<Worker | undefined>;
  delete(id: string): Promise<boolean>;
  rotateToken(id: string, currentTokenHash: string, nextTokenHash: string, at: number): Promise<Worker | undefined>;
  markOffline(cutoff: number, at: number): Promise<Worker[]>;
  registerTaskSession(taskId: string, sessionId: string, baseUrl: string, updatedAt: number): Promise<void>;
  getTaskSessions(taskId: string): Promise<readonly RegisteredWorkerOpenCodeSession[]>;
  clearTaskSessions(taskId: string): Promise<void>;
  enqueueTaskCommand(taskId: string, command: WorkerTaskCommand): Promise<void>;
  claimTaskCommands(taskId: string, limit: number): Promise<readonly WorkerTaskCommand[]>;
  clearTaskCommands(taskId: string): Promise<void>;
}
