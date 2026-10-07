import type { A2AAgent, A2ASkill, A2AWorkflowRole } from '../types.js';

export interface RegisterA2AAgentInput {
  id: string;
  agentCardUrl: string;
  name: string;
  description: string;
  version: string;
  endpoint: string;
  protocolVersion: string;
  skills: readonly (Omit<A2ASkill, 'tags'> & { tags: readonly string[] })[];
  enabled: boolean;
  now: number;
}

export interface A2AAgentRepository {
  getAll(): Promise<A2AAgent[]>;
  getById(id: string): Promise<A2AAgent | undefined>;
  register(input: RegisterA2AAgentInput): Promise<A2AAgent>;
  setEnabled(id: string, enabled: boolean, now: number): Promise<A2AAgent | undefined>;
  setProjectRoles(id: string, projectId: string, roles: readonly A2AWorkflowRole[], now: number): Promise<A2AAgent | undefined>;
  recordRefreshFailure(id: string, error: string, now: number): Promise<A2AAgent | undefined>;
  refresh(id: string, input: Omit<RegisterA2AAgentInput, 'id' | 'agentCardUrl' | 'enabled' | 'now'> & { now: number }): Promise<A2AAgent | undefined>;
  delete(id: string): Promise<boolean>;
}
