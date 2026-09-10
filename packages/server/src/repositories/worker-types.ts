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

export interface WorkerRepository {
  register(input: WorkerRegistration): Promise<Worker>;
  heartbeat(id: string, at: number): Promise<Worker | undefined>;
  getById(id: string): Promise<Worker | undefined>;
  getByTokenHash(tokenHash: string): Promise<(Worker & { readonly tokenHash: string }) | undefined>;
  list(): Promise<Worker[]>;
  markOffline(cutoff: number, at: number): Promise<Worker[]>;
}
