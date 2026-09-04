import type { AgentType, Priority, Project } from '../types.js';

export interface ProjectRepository {
  getAllWithCounts(): Promise<Project[]>;
  getById(id: string): Promise<Project | undefined>;
  getDefault(): Promise<Project | undefined>;
  resolve(reference: string): Promise<Project[]>;
  create(input: {
    id: string;
    name: string;
    repoPath?: string;
    repoUrl?: string;
    defaultAgentType?: AgentType;
    defaultPriority?: Priority;
    defaultBaseBranch?: string;
    defaultUseWorktree?: boolean;
    aliases?: string[];
    jiraImportEnabled?: boolean;
    jiraImportIntervalMinutes?: number;
    jiraImportLastRunAt?: number;
    jiraImportLastCompletedAt?: number;
    jiraImportLastSuccessAt?: number;
    jiraImportLastError?: string;
    jiraImportLastTotal?: number;
    jiraImportLastCreated?: number;
    jiraImportLastSkipped?: number;
    jiraImportAutoStart?: boolean;
    createdAt: number;
    updatedAt: number;
  }): Promise<Project>;
  update(id: string, updates: {
    name?: string;
    repoPath?: string | null;
    repoUrl?: string | null;
    defaultAgentType?: AgentType | null;
    defaultPriority?: Priority | null;
    defaultBaseBranch?: string | null;
    defaultUseWorktree?: boolean | null;
    aliases?: string[];
    jiraImportEnabled?: boolean;
    jiraImportIntervalMinutes?: number;
    jiraImportLastRunAt?: number | null;
    jiraImportLastCompletedAt?: number | null;
    jiraImportLastSuccessAt?: number | null;
    jiraImportLastError?: string | null;
    jiraImportLastTotal?: number | null;
    jiraImportLastCreated?: number | null;
    jiraImportLastSkipped?: number | null;
    jiraImportAutoStart?: boolean;
    updatedAt: number;
  }): Promise<Project | undefined>;
  hasTasksOrGroups(id: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}
