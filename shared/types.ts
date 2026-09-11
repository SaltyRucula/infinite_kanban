export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type ColumnId = 'backlog' | 'in-progress' | 'pending' | 'review' | 'done';
export type AgentStatus = 'idle' | 'planning' | 'executing' | 'awaiting_clarification' | 'complete' | 'failed';
export type AgentType = 'copilot' | 'claude' | 'codex' | 'opencode' | 'hermes' | 'openclaw' | 'grok';
export type WorkerStatus = 'online' | 'offline' | 'disabled';

export interface AgentInfo {
  name: AgentType;
  displayName: string;
  available: boolean;
  version?: string;
  reason?: string;
}

/**
 * A registered remote worker: a separate machine/process running the
 * `@ai-agent-board/worker` CLI, capable of claiming and executing tasks
 * assigned to it. Distinct from `AgentInfo` (which lists CLI providers
 * detected on the server's own PATH) — a worker is a real, addressable
 * execution endpoint with its own identity, heartbeat, and lease state.
 */
export interface Worker {
  id: string;
  name: string;
  status: WorkerStatus;
  agentTypes: AgentType[];
  hostname?: string;
  version?: string;
  maxConcurrentTasks: number;
  registeredAt: number;
  lastHeartbeatAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  columnId: ColumnId;
  agentStatus: AgentStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  repoPath?: string;
  branchName?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  worktreePath?: string;
  agentType?: AgentType;
  archived?: boolean;
  groupId?: string;
  groupOrder?: number;
  attachments?: TaskAttachment[];
  projectId: string;
  summary?: string | null;
  runRequestedAt?: number;
  runClaimedAt?: number;
  externalSource?: string;
  externalKey?: string;
  provenance?: TaskProvenance;
  /** Optional execution limit for this task. Omit to use the server default. */
  timeoutMinutes?: number | null;
  clarificationRequest?: TaskClarificationRequest | null;
  clarificationAnswer?: TaskClarificationAnswer | null;
  /**
   * When set, this task is executed by the named remote worker (pulled/claimed
   * over the worker REST API) instead of the server's in-process AgentManager.
   * Assignment is only permitted before the task is claimed/running.
   */
  assignedWorkerId?: string | null;
}

export interface WorkerTaskAssignment {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  agentType?: AgentType;
  branchName?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  timeoutMinutes?: number | null;
}

export interface ClarificationRequestPayload {
  requestId: string;
  prompt: string;
  choices?: readonly string[];
  timestamp: number;
}

export interface TaskClarificationRequest extends ClarificationRequestPayload {
  sessionId: string;
}

export interface TaskClarificationAnswer {
  requestId: string;
  answer: string;
  timestamp: number;
  sessionId: string;
}

export interface TaskProvenance {
  sourceProfile?: string;
  sourcePlatform?: string;
  sourceSession?: string;
  sourceMessage?: string;
  requestedBy?: string;
  origin?: Record<string, string | number | boolean | null>;
}

export interface TaskGroup {
  id: string;
  title: string;
  description?: string;
  priority: Priority;
  columnId: ColumnId;
  repoPath?: string;
  baseBranch?: string;
  maxConcurrency: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  archived?: boolean;
  projectId: string;
}

export interface ProjectTaskCounts {
  backlog: number;
  'in-progress': number;
  pending: number;
  review: number;
  done: number;
  total: number;
}

export interface Project {
  id: string;
  name: string;
  repoPath?: string;
  /** Source GitHub/git URL the project's local repo was cloned from, if any. */
  repoUrl?: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  taskCounts?: ProjectTaskCounts;
  /** Default task properties for this project. Each is overridable per task. */
  defaultAgentType?: AgentType;
  defaultPriority?: Priority;
  defaultBaseBranch?: string;
  defaultUseWorktree?: boolean;
  aliases?: string[];
  readonly jiraImportEnabled: boolean;
  readonly jiraImportIntervalMinutes: number;
  readonly jiraImportAutoStart: boolean;
  readonly jiraImportLastRunAt?: number;
  readonly jiraImportLastCompletedAt?: number;
  readonly jiraImportLastSuccessAt?: number;
  readonly jiraImportLastError?: string;
  readonly jiraImportLastTotal?: number;
  readonly jiraImportLastCreated?: number;
  readonly jiraImportLastSkipped?: number;
}

export interface CreateProjectRequest {
  name?: string;
  repoPath?: string;
  /** When provided, the server clones this git URL into the configured clone root and uses it as repoPath. */
  repoUrl?: string;
  defaultAgentType?: AgentType;
  defaultPriority?: Priority;
  defaultBaseBranch?: string;
  defaultUseWorktree?: boolean;
  aliases?: string[];
  readonly jiraImportEnabled?: boolean;
  readonly jiraImportIntervalMinutes?: number;
  readonly jiraImportAutoStart?: boolean;
  readonly jiraImportLastRunAt?: number;
  readonly jiraImportLastCompletedAt?: number;
  readonly jiraImportLastSuccessAt?: number;
  readonly jiraImportLastError?: string;
  readonly jiraImportLastTotal?: number;
  readonly jiraImportLastCreated?: number;
  readonly jiraImportLastSkipped?: number;
}

export interface UpdateProjectRequest {
  name?: string;
  repoPath?: string | null;
  repoUrl?: string | null;
  defaultAgentType?: AgentType | null;
  defaultPriority?: Priority | null;
  defaultBaseBranch?: string | null;
  defaultUseWorktree?: boolean | null;
  aliases?: string[];
  readonly jiraImportEnabled?: boolean;
  readonly jiraImportIntervalMinutes?: number;
  readonly jiraImportAutoStart?: boolean;
  readonly jiraImportLastRunAt?: number;
  readonly jiraImportLastCompletedAt?: number;
  readonly jiraImportLastSuccessAt?: number;
  readonly jiraImportLastError?: string;
  readonly jiraImportLastTotal?: number;
  readonly jiraImportLastCreated?: number;
  readonly jiraImportLastSkipped?: number;
}

/** Server-side Agent Board configuration (persisted to the config file). */
export interface ProjectConfig {
  /** Absolute path under which repos cloned from a URL are placed. */
  cloneRoot: string;
}

export interface ProjectPathValidation {
  repoPath: string;
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  error?: string;
  warning?: string;
}

export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command'
  | 'command_output'
  | 'output'
  | 'test_result'
  | 'error'
  | 'complete';

export interface AgentEvent {
  id: string;
  taskId: string;
  type: AgentEventType;
  content: string;
  timestamp: number;
  metadata?: {
    file?: string;
    fileEventType?: string;
    language?: string;
    command?: string;
    diff?: string;
    agentType?: AgentType;
    duration?: number;
    error?: string;
    clarification_request?: ClarificationRequestPayload;
    clarification_answer?: TaskClarificationAnswer;
  };
}

export interface Column {
  id: ColumnId;
  title: string;
  color: string;
  icon: string;
}

export interface AgentCompletePayload {
  taskId: string;
  status: 'complete' | 'failed';
  agentType?: AgentType;
  duration: number;
  eventCount: number;
}

export interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  description: string;
  priority: Priority;
  agentType: AgentType;
  repoPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  createdAt: number;
}

export interface AgentFollowUpPayload {
  taskId: string;
  message: string;
  attachmentIds?: string[];
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export interface JiraImportResult {
  total: number;
  created: number;
  skipped: number;
  tasks: Task[];
}

export type WSMessage =
  | { type: 'agent_event'; payload: AgentEvent }
  | { type: 'task_updated'; payload: Task }
  | { type: 'task_deleted'; payload: { id: string } }
  | { type: 'agent_complete'; payload: AgentCompletePayload }
  | { type: 'agent_follow_up'; payload: AgentFollowUpPayload }
  | { type: 'group_updated'; payload: TaskGroup }
  | { type: 'project_updated'; payload: Project }
  | { type: 'project_deleted'; payload: { id: string } }
  | { type: 'worker_updated'; payload: Worker }
  | { type: 'worker_removed'; payload: { id: string } };
