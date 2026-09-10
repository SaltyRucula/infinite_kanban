import { resolveOpenCodeBaseUrl } from '../opencode/config.js';
import { PowerAssertion } from './power-assertion.js';
import { v4 as uuid } from 'uuid';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  Task,
  TaskGroup,
  AgentEvent,
  AgentType,
  ClarificationRequestPayload,
  TaskClarificationRequest,
  TaskClarificationAnswer,
} from '../types.js';
import type { TaskRepository } from '../repositories/types.js';
import type { AgentProvider, AgentSession, AgentInfo, AgentAttachment } from '@codewithdan/agent-sdk-core';
import type { AgentEvent as CoreAgentEvent } from '@codewithdan/agent-sdk-core';
import { CopilotProvider, ClaudeProvider, CodexProvider, HermesProvider, OpenClawProvider, GrokProvider } from '@codewithdan/agent-sdk-core';
import { NonDestructiveOpenCodeProvider } from '../opencode/non-destructive-provider.js';
import { broadcast } from '../websocket.js';
import { UPLOADS_DIR } from '../routes/attachments.js';
import type { AttachmentStore } from '../repositories/attachment-types.js';
import { errorMessage, errorMessageWithCause } from '../utils.js';
import { detectAvailableAgents } from './agent-detection.js';
import { resolveTaskTimeoutMs } from './agent-timeout.js';

function loadAttachmentAsBase64(filePath: string, displayName: string, mimeType: string): AgentAttachment | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[agent-manager] attachment file not found: ${filePath}`);
      return null;
    }
    const fileBuffer = fs.readFileSync(filePath);
    const data = fileBuffer.toString('base64');
    console.log(`[agent-manager] loaded attachment: ${displayName} (${mimeType}, ${fileBuffer.length} bytes, base64 length: ${data.length})`);
    return { type: 'base64_image', data, displayName, mediaType: mimeType };
  } catch (err) {
    console.error(`[agent-manager] failed to load attachment ${filePath}:`, err);
    return null;
  }
}

interface ManagedSession {
  session?: AgentSession;
  timeoutId?: ReturnType<typeof setTimeout>;
  startTime: number;
  agentType: AgentType;
  sessionId: string | null;
  onStatusChange: (status: Task['agentStatus']) => void | Promise<void>;
}

interface ClarificationState {
  request: TaskClarificationRequest;
  answer?: TaskClarificationAnswer;
  resumeInFlight: boolean;
}

interface ClarificationAnswerRequest {
  requestId: string;
  sessionId: string;
  answer: string;
}

interface ClarificationResumeResult {
  ok: boolean;
  code:
    | 'resumed'
    | 'invalid_request'
    | 'no_pending_clarification'
    | 'session_not_running'
    | 'stale_session'
    | 'stale_request'
    | 'duplicate_answer'
    | 'send_failed';
  message: string;
}

function parseClarificationRequestPayload(value: unknown): ClarificationRequestPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const requestId = raw.requestId;
  const prompt = raw.prompt;
  const timestamp = raw.timestamp;
  const choices = raw.choices;

  if (typeof requestId !== 'string' || requestId.trim().length === 0) return null;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return null;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;

  if (choices === undefined) {
    return { requestId: requestId.trim(), prompt: prompt.trim(), timestamp };
  }
  if (!Array.isArray(choices)) return null;
  if (!choices.every((choice) => typeof choice === 'string' && choice.trim().length > 0)) return null;
  return {
    requestId: requestId.trim(),
    prompt: prompt.trim(),
    choices: choices.map((choice) => (choice as string).trim()),
    timestamp,
  };
}

// Event log per task (capped to prevent unbounded growth)
const MAX_EVENTS_PER_TASK = 2000;
const MAX_EVENT_LOG_TASKS = 200;

// Deleted-task guard TTL
const DELETED_TASK_TTL_MS = 60_000;

const STREAM_BUFFER_FLUSH_MS = 40;
const STOPPED_TASK_TTL_MS = 30_000;

// Upper bound on accumulated assistant prose kept for summary extraction.
// We only need the tail (the final <task-summary> block), so cap memory use.
const MAX_SUMMARY_BUFFER = 64_000;

const REDACTED_AGENT_ENV_KEYS = ['JIRA_API_TOKEN', 'JIRA_USER_EMAIL'] as const;

let activeAgentSecretRedactionCount = 0;
let redactedAgentSecretPreviousValues: Map<string, string | undefined> | null = null;

function beginAgentSecretRedaction(): void {
  if (activeAgentSecretRedactionCount === 0) {
    redactedAgentSecretPreviousValues = new Map<string, string | undefined>();
    for (const key of REDACTED_AGENT_ENV_KEYS) {
      redactedAgentSecretPreviousValues.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  activeAgentSecretRedactionCount += 1;
}

function endAgentSecretRedaction(): void {
  if (activeAgentSecretRedactionCount === 0) {
    return;
  }

  activeAgentSecretRedactionCount -= 1;
  if (activeAgentSecretRedactionCount !== 0) {
    return;
  }

  for (const key of REDACTED_AGENT_ENV_KEYS) {
    const value = redactedAgentSecretPreviousValues?.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  redactedAgentSecretPreviousValues = null;
}

async function withAgentSecretsRedacted<T>(run: () => Promise<T>): Promise<T> {
  beginAgentSecretRedaction();

  try {
    return await run();
  } finally {
    endAgentSecretRedaction();
  }
}

/**
 * Extract the agent-authored task summary from accumulated assistant prose.
 * Returns the trimmed contents of the LAST `<task-summary>…</task-summary>`
 * block, or null when no usable block is present.
 */
function extractTaskSummary(buffer: string): string | null {
  if (!buffer) return null;
  const closed = [...buffer.matchAll(/<task-summary>([\s\S]*?)<\/task-summary>/g)];
  if (closed.length > 0) {
    const body = closed[closed.length - 1][1].trim();
    return body.length > 0 ? body : null;
  }
  // Tolerate a missing closing tag: take everything after the last opening tag.
  const openIdx = buffer.lastIndexOf('<task-summary>');
  if (openIdx >= 0) {
    const body = buffer.slice(openIdx + '<task-summary>'.length).replace(/<\/task-summary>/g, '').trim();
    return body.length > 0 ? body : null;
  }
  return null;
}

function getErrorStderr(err: unknown): string {
  if (err instanceof Error && 'stderr' in err) {
    const stderr = (err as Error & { stderr?: Buffer | string }).stderr;
    return stderr?.toString() ?? '';
  }
  return '';
}

/**
 * Compare two worktree paths for equality, resolving symlinks first so macOS
 * `/var/...` (stored) and git's canonical `/private/var/...` (reported) match.
 * Falls back to the raw string when a path cannot be canonicalized.
 */
export function worktreePathsMatch(
  a: string,
  b: string,
  canonicalize: (p: string) => string = (p) => fs.realpathSync(p),
): boolean {
  const norm = (p: string): string => {
    let resolved = p;
    try {
      resolved = canonicalize(p);
    } catch {
      resolved = p;
    }
    return resolved.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  };
  return norm(a) === norm(b);
}

interface GroupQueue {
  groupId: string;
  maxConcurrency: number;
  pendingTaskIds: string[];
  runningTaskIds: Set<string>;
  awaitingTaskIds: Set<string>;
  completedTaskIds: Set<string>;
  failedTaskIds: Set<string>;
  tasks: Map<string, Task>;
  makeStatusCallback: (task: Task) => (status: Task['agentStatus'], failure?: string) => void | Promise<void>;
  makeWorktreeCallback: (task: Task) => (worktreePath: string) => void | Promise<void>;
  onChildComplete: (taskId: string) => void | Promise<void>;
  resumeReacquireChain: Promise<void>;
}

export class AgentManager {
  private providers = new Map<AgentType, AgentProvider>();
  private sessions = new Map<string, ManagedSession>();
  private deletedTasks = new Set<string>();
  /** Tasks stopped by user — prevents duplicate agent_complete from terminateOnce */
  private stoppedTasks = new Set<string>();
  private eventLogs = new Map<string, AgentEvent[]>();
  private eventRepo: TaskRepository | null = null;
  private attachmentStore: AttachmentStore | null = null;
  private availableAgents: AgentInfo[] = [];
  /** Pending coalesced output/thinking broadcast per task */
  private streamBuffer = new Map<string, { event: AgentEvent; timer: ReturnType<typeof setTimeout> }>();
  private groupQueues = new Map<string, GroupQueue>();
  /** Per-repo mutex to serialize git operations (merge, checkout) */
  private repoLocks = new Map<string, Promise<void>>();
  private clarifications = new Map<string, ClarificationState>();
  private readonly powerAssertion = new PowerAssertion();

  private syncPowerAssertion(): void {
    this.powerAssertion.sync(this.sessions.size);
  }


  /** Call once at startup to enable event persistence. */
  initEventPersistence(repo: TaskRepository): void {
    this.eventRepo = repo;
  }

  initAttachmentStore(store: AttachmentStore): void {
    this.attachmentStore = store;
  }

  /** Detect available agents, register providers, start the ones that are available. */
  async initialize(): Promise<void> {
    const openCodeConfig = createOpenCodeProviderConfig();

    // Register all providers
    this.providers.set('copilot', new CopilotProvider());
    this.providers.set('claude', new ClaudeProvider());
    this.providers.set('codex', new CodexProvider());
    this.providers.set(
      'opencode',
      openCodeConfig.mode === 'managed'
        ? new NonDestructiveOpenCodeProvider()
        : new NonDestructiveOpenCodeProvider({ baseUrl: openCodeConfig.baseUrl }),
    );
    this.providers.set('hermes', new HermesProvider());
    this.providers.set('openclaw', new OpenClawProvider());
    this.providers.set('grok', new GrokProvider());

    // Detect which agents are actually available on this system
    this.availableAgents = await detectAvailableAgents();
    const available = this.availableAgents.filter(a => a.available);

    console.log(
      `[agent-manager] detected agents: ${this.availableAgents.map(a => `${a.displayName}=${a.available ? 'yes' : 'no'}`).join(', ')}`
    );

    // In test/CI environments there are no real agent credentials, and some
    // provider SDKs spawn a background session on start() that rejects (e.g.
    // Copilot without GitHub auth) as a detached unhandled rejection — which
    // would crash the server. When startup is disabled we skip booting real SDK
    // clients. Because no provider is started, no agent can actually run, so we
    // also report every detected agent as unavailable. This keeps the agents
    // listed in the UI (as "Unavailable") while ensuring real-execution E2E
    // specs skip instead of attempting sessions that would hang or fail — a CLI
    // shim on PATH (e.g. node_modules/.bin/copilot) otherwise makes detection
    // report an agent that cannot be used here as "available".
    const skipAgentStartup =
      process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === '1' ||
      process.env.AGENTBOARD_DISABLE_AGENT_STARTUP === 'true';
    if (skipAgentStartup) {
      console.log('[agent-manager] AGENTBOARD_DISABLE_AGENT_STARTUP set — skipping provider start()');
      this.availableAgents = this.availableAgents.map(a => ({
        ...a,
        available: false,
        reason: 'Agent startup disabled (test environment)',
      }));
      return;
    }

    // Start available providers
    for (const info of available) {
      const provider = this.providers.get(info.name);
      if (provider) {
        try {
          await withAgentSecretsRedacted(async () => {
            await provider.start();
          });
        } catch (err: unknown) {
          console.error(`[agent-manager] failed to start ${info.displayName}: ${errorMessage(err)}`);
          // Mark as unavailable
          const agentInfo = this.availableAgents.find(a => a.name === info.name);
          if (agentInfo) {
            agentInfo.available = false;
            agentInfo.reason = `Failed to start: ${errorMessage(err)}`;
          }
        }
      }
    }
  }

  async refresh(): Promise<AgentInfo[]> {
    const detected = await detectAvailableAgents();
    for (const info of detected) {
      const provider = this.providers.get(info.name);
      if (!info.available || !provider) continue;
      const wasAvailable = this.availableAgents.find((item) => item.name === info.name)?.available;
      if (wasAvailable) continue;
      try {
        await withAgentSecretsRedacted(async () => {
          await provider.start();
        });
      } catch (err: unknown) {
        info.available = false;
        info.reason = `Failed to start: ${errorMessage(err)}`;
      }
    }
    this.availableAgents = detected;
    return this.getAvailableAgents();
  }

  getAvailableAgents(): AgentInfo[] {
    return [...this.availableAgents];
  }

  registerProvider(provider: AgentProvider): void {
    this.providers.set(provider.name, provider);
  }

  setAvailableAgents(agents: AgentInfo[]): void {
    this.availableAgents = [...agents];
  }

  getSessionIdentity(taskId: string): string | null {
    return this.sessions.get(taskId)?.sessionId ?? null;
  }

  private async persistTaskClarification(
    taskId: string,
    clarificationRequest: Task['clarificationRequest'],
    clarificationAnswer: Task['clarificationAnswer'],
  ): Promise<void> {
    const updated = await this.eventRepo?.update(taskId, {
      clarificationRequest,
      clarificationAnswer,
    });
    if (updated) {
      broadcast({ type: 'task_updated', payload: updated });
    }
  }

  private markStoppedTask(taskId: string): void {
    this.stoppedTasks.add(taskId);
    setTimeout(() => this.stoppedTasks.delete(taskId), STOPPED_TASK_TTL_MS);
  }

  private async failActiveSession(taskId: string, reason: string): Promise<void> {
    const entry = this.sessions.get(taskId);
    if (!entry) return;

    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    const duration = Date.now() - entry.startTime;
    this.sessions.delete(taskId);
    this.syncPowerAssertion();
    this.markStoppedTask(taskId);
    this.clarifications.delete(taskId);

    (async () => {
      try { await entry.session?.abort(); } catch {}
      try { await entry.session?.destroy(); } catch {}
    })();

    this.emitEvent(taskId, {
      id: uuid(),
      taskId,
      type: 'error',
      content: reason,
      timestamp: Date.now(),
      metadata: { agentType: entry.agentType, duration, error: reason },
    });

    broadcast({
      type: 'agent_complete',
      payload: {
        taskId,
        status: 'failed',
        agentType: entry.agentType,
        duration,
        eventCount: (await this.getEvents(taskId)).length,
      },
    });

    await entry.onStatusChange('failed');
  }

  private async pauseForClarification(taskId: string, payload: ClarificationRequestPayload): Promise<void> {
    const entry = this.sessions.get(taskId);
    if (!entry?.session) return;

    const liveSessionId = entry.sessionId;
    if (!liveSessionId) {
      await this.failActiveSession(
        taskId,
        `${entry.agentType} provider cannot resume live clarification because it does not expose a stable session identity while execute() is in-flight.`,
      );
      return;
    }

    const request: TaskClarificationRequest = {
      ...payload,
      sessionId: liveSessionId,
    };

    const prior = this.clarifications.get(taskId);
    if (
      prior
      && prior.request.requestId === request.requestId
      && prior.request.sessionId === request.sessionId
    ) {
      return;
    }

    this.clarifications.set(taskId, {
      request,
      resumeInFlight: false,
    });

    await this.persistTaskClarification(taskId, request, null);

    this.emitEvent(taskId, {
      id: uuid(),
      taskId,
      type: 'command',
      content: request.prompt,
      timestamp: request.timestamp,
      metadata: {
        agentType: entry.agentType,
        clarification_request: payload,
      },
    });

    await entry.onStatusChange('awaiting_clarification');
  }

  async resumeClarification(taskId: string, input: ClarificationAnswerRequest): Promise<ClarificationResumeResult> {
    const requestId = input.requestId.trim();
    const sessionId = input.sessionId.trim();
    const answerText = input.answer.trim();
    if (!requestId || !sessionId || !answerText) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'requestId, sessionId, and answer are required',
      };
    }

    const entry = this.sessions.get(taskId);
    if (!entry?.session) {
      return {
        ok: false,
        code: 'session_not_running',
        message: 'no live agent session is running for this task',
      };
    }
    const activeSession = entry.session;

    const clarification = this.clarifications.get(taskId);
    if (!clarification) {
      return {
        ok: false,
        code: 'no_pending_clarification',
        message: 'there is no pending clarification for this task',
      };
    }

    if (clarification.request.requestId !== requestId) {
      return {
        ok: false,
        code: 'stale_request',
        message: 'clarification requestId does not match the current pending request',
      };
    }

    if (!entry.sessionId || clarification.request.sessionId !== sessionId || entry.sessionId !== sessionId) {
      return {
        ok: false,
        code: 'stale_session',
        message: 'clarification response sessionId does not match the live session identity',
      };
    }

    if (clarification.answer || clarification.resumeInFlight) {
      return {
        ok: false,
        code: 'duplicate_answer',
        message: 'clarification answer already accepted for this request',
      };
    }

    clarification.resumeInFlight = true;
    const clarificationAnswer: TaskClarificationAnswer = {
      requestId,
      answer: answerText,
      timestamp: Date.now(),
      sessionId,
    };
    clarification.answer = clarificationAnswer;

    await this.persistTaskClarification(taskId, clarification.request, clarificationAnswer);

    this.emitEvent(taskId, {
      id: uuid(),
      taskId,
      type: 'command',
      content: `Clarification answered: ${answerText}`,
      timestamp: clarificationAnswer.timestamp,
      metadata: {
        agentType: entry.agentType,
        clarification_answer: clarificationAnswer,
      },
    });

    try {
      await withAgentSecretsRedacted(async () => activeSession.send(answerText));
      clarification.resumeInFlight = false;
      await entry.onStatusChange('executing');
      return {
        ok: true,
        code: 'resumed',
        message: 'clarification accepted and session resumed',
      };
    } catch (err) {
      clarification.answer = undefined;
      clarification.resumeInFlight = false;
      await this.persistTaskClarification(taskId, clarification.request, null);
      const providerName = this.providers.get(entry.agentType)?.displayName || entry.agentType;
      const reason = `${providerName} cannot resume live clarification via session.send() while execute() is in-flight: ${errorMessage(err)}`;
      await this.failActiveSession(taskId, reason);
      return {
        ok: false,
        code: 'send_failed',
        message: reason,
      };
    }
  }

  // ─── Event Management (moved from copilot.ts) ─────────────────────

  private emitEvent(taskId: string, event: AgentEvent): void {
    if (this.deletedTasks.has(taskId)) return;
    // Drop empty content events — nothing to show
    if (!event.content?.trim() && event.type !== 'complete' && event.type !== 'error') return;

    let log = this.eventLogs.get(taskId) || [];
    log.push(event);
    if (log.length > MAX_EVENTS_PER_TASK) {
      log = log.slice(-MAX_EVENTS_PER_TASK);
    }
    // LRU touch
    this.eventLogs.delete(taskId);
    this.eventLogs.set(taskId, log);
    if (this.eventLogs.size > MAX_EVENT_LOG_TASKS) {
      const oldest = this.eventLogs.keys().next().value;
      if (oldest) this.eventLogs.delete(oldest);
    }
    // Write-through to database
    if (this.eventRepo) {
      this.eventRepo.insertEvent(event).catch((err: unknown) => {
        console.error(`[agent-manager] failed to persist event: ${errorMessage(err)}`);
      });
    }
    const STREAMABLE = new Set(['output', 'thinking']);

    const flushBuffer = (taskId: string) => {
      const buf = this.streamBuffer.get(taskId);
      if (buf) {
        clearTimeout(buf.timer);
        broadcast({ type: 'agent_event', payload: buf.event });
        this.streamBuffer.delete(taskId);
      }
    };

    if (STREAMABLE.has(event.type)) {
      const existing = this.streamBuffer.get(event.taskId);
      if (existing && existing.event.type === event.type) {
        // Same type — merge content and reset timer
        clearTimeout(existing.timer);
        existing.event.content += event.content;
        existing.timer = setTimeout(() => flushBuffer(event.taskId), STREAM_BUFFER_FLUSH_MS);
      } else {
        // Different type or no buffer — flush existing, start new buffer
        if (existing) flushBuffer(event.taskId);
        const timer = setTimeout(() => flushBuffer(event.taskId), STREAM_BUFFER_FLUSH_MS);
        this.streamBuffer.set(event.taskId, { event: { ...event }, timer });
      }
    } else {
      // Non-streamable: flush pending buffer first, then broadcast immediately
      flushBuffer(event.taskId);
      broadcast({ type: 'agent_event', payload: event });
    }
  }

  async getEvents(taskId: string): Promise<AgentEvent[]> {
    // Prefer DB (complete, ordered) over in-memory (capped, may be partial)
    if (this.eventRepo) {
      const dbEvents = await this.eventRepo.getEventsByTaskId(taskId);
      if (dbEvents.length > 0) return dbEvents;
    }
    // Fall back to in-memory (task still running, not yet persisted)
    const memEvents = this.eventLogs.get(taskId);
    if (memEvents && memEvents.length > 0) {
      this.eventLogs.delete(taskId);
      this.eventLogs.set(taskId, memEvents);
      return [...memEvents];
    }
    return [];
  }

  clearEvents(taskId: string): void {
    this.deletedTasks.add(taskId);
    setTimeout(() => this.deletedTasks.delete(taskId), DELETED_TASK_TTL_MS);
    this.resetEvents(taskId);
  }

  /** Clear stored events for a task without suppressing future events (used on re-run) */
  resetEvents(taskId: string): void {
    this.eventLogs.delete(taskId);
    if (this.eventRepo) {
      this.eventRepo.deleteEventsByTaskId(taskId).catch((err: unknown) => {
        console.error(`[agent-manager] failed to delete persisted events: ${errorMessage(err)}`);
      });
    }
  }

  // ─── Worktree Management (moved from copilot.ts) ──────────────────

  // Returns true when `worktreePath` is registered with git as a worktree
  // checked out on `branchName`. Used to safely reuse a worktree left over
  // from a prior (e.g. failed) run instead of colliding on the branch.
  private worktreeRegisteredForBranch(repoPath: string, worktreePath: string, branchName: string): boolean {
    try {
      const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        stdio: 'pipe',
      }).toString();
      for (const block of out.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/);
        const wtLine = lines.find((l) => l.startsWith('worktree '));
        if (!wtLine) continue;
        if (!worktreePathsMatch(wtLine.slice('worktree '.length), worktreePath)) continue;
        return lines.includes(`branch refs/heads/${branchName}`);
      }
    } catch {
      /* fall through — treat as not reusable */
    }
    return false;
  }

  setupWorktree(task: Task): string | undefined {
    if (!task.useWorktree) return undefined;
    if (!task.repoPath) throw new Error('Worktree tasks require repoPath');
    if (!task.branchName) throw new Error('Worktree tasks require branchName');

    // Reuse a valid worktree left over from a prior run (e.g. after a failed
    // attempt). Without this, a restart would mint a new temp dir and fail with
    // "branch already used by worktree", since the old worktree still holds the
    // branch — and any in-progress work in it would be stranded.
    if (
      task.worktreePath &&
      path.resolve(task.worktreePath) !== path.resolve(task.repoPath) &&
      fs.existsSync(task.worktreePath) &&
      this.worktreeRegisteredForBranch(task.repoPath, task.worktreePath, task.branchName)
    ) {
      console.log(`[worktree] reusing existing ${task.worktreePath}`);
      return task.worktreePath;
    }

    // Clear stale worktree records (e.g. dirs deleted out from under git) so a
    // fresh add for this branch isn't blocked by a dangling registration.
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: task.repoPath, stdio: 'pipe' });
    } catch {
      /* best effort */
    }

    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), `agentboard-${task.id}-`));
    const baseBranch = task.baseBranch || 'main';

    try {
      execFileSync(
        'git', ['worktree', 'add', '-b', task.branchName, worktreePath, baseBranch],
        { cwd: task.repoPath, stdio: 'pipe' },
      );
      console.log(`[worktree] created at ${worktreePath} from ${baseBranch}`);
      return worktreePath;
    } catch (err1: unknown) {
      try {
        execFileSync(
          'git', ['worktree', 'add', worktreePath, task.branchName],
          { cwd: task.repoPath, stdio: 'pipe' },
        );
        console.log(`[worktree] attached existing branch ${task.branchName} at ${worktreePath}`);
        return worktreePath;
      } catch (err2: unknown) {
        console.error(`[worktree] failed:`, errorMessage(err2));
        // Surface both attempts — the primary create-branch failure (err1) is
        // usually the actionable one (e.g. baseBranch doesn't exist, or the
        // repo has no commits yet), while err2 only reflects the fallback
        // assuming a pre-existing branch that also wasn't there.
        throw new Error(
          `Failed to create worktree: ${errorMessage(err2)} (create-branch attempt: ${errorMessage(err1)})`,
        );
      }
    }
  }

  removeWorktree(task: Task): void {
    if (!task.worktreePath || !task.repoPath) return;
    try {
      execFileSync('git', ['worktree', 'remove', task.worktreePath, '--force'], {
        cwd: task.repoPath,
        stdio: 'pipe',
      });
      console.log(`[worktree] removed ${task.worktreePath}`);
    } catch (err: unknown) {
      console.error(`[worktree] remove failed:`, errorMessage(err));
      throw new Error(`Failed to remove worktree: ${errorMessage(err)}`);
    }
  }

  createPR(task: Task): { url: string } {
    if (!task.repoPath || !task.branchName) {
      throw new Error('Task has no repo path or branch name configured');
    }
    const baseBranch = task.baseBranch || 'main';
    const cwd = task.worktreePath || task.repoPath;

    // Check that a remote named 'origin' exists
    try {
      const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, stdio: 'pipe' }).toString().trim();
      if (!remoteUrl) throw new Error('empty');
    } catch {
      throw new Error(
        'No git remote "origin" configured. Push your repo to GitHub first:\n' +
        `  cd ${task.repoPath}\n` +
        '  gh repo create <name> --source=. --push'
      );
    }

    try {
      execFileSync('git', ['push', '-u', 'origin', task.branchName], { cwd, stdio: 'pipe' });
      const prTitle = task.title.replace(/[<>]/g, '').slice(0, 200);
      const result = execFileSync(
        'gh',
        ['pr', 'create', '--base', baseBranch, '--head', task.branchName,
         '--title', prTitle, '--body', `Automated PR from Kanban task ${task.id}`, '--'],
        { cwd, stdio: 'pipe' },
      );
      const url = result.toString().trim();
      console.log(`[pr] created: ${url}`);
      return { url };
    } catch (err: unknown) {
      const stderr = getErrorStderr(err);
      const msg = stderr || errorMessage(err);
      console.error(`[pr] creation failed:`, msg);
      throw new Error(`PR creation failed: ${msg.trim()}`);
    }
  }

  private async withRepoLock<T>(repoPath: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.repoLocks.get(repoPath) ?? Promise.resolve();
    let resolve: () => void;
    const lock = new Promise<void>((r) => { resolve = r; });
    this.repoLocks.set(repoPath, lock);
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
      if (this.repoLocks.get(repoPath) === lock) this.repoLocks.delete(repoPath);
    }
  }

  async mergeLocal(task: Task): Promise<{ merged: true; baseBranch: string }> {
    if (!task.repoPath || !task.branchName) {
      throw new Error('Task has no repo path or branch name configured');
    }
    const repoPath = task.repoPath;
    const branchName = task.branchName;
    const baseBranch = task.baseBranch || 'main';

    return this.withRepoLock(repoPath, () => {
      try {
        execFileSync('git', ['checkout', baseBranch], { cwd: repoPath, stdio: 'pipe' });
        execFileSync('git', ['merge', branchName, '--no-edit'], { cwd: repoPath, stdio: 'pipe' });
        console.log(`[merge] merged ${branchName} into ${baseBranch}`);
        return { merged: true as const, baseBranch };
      } catch (err: unknown) {
        try { execFileSync('git', ['merge', '--abort'], { cwd: repoPath, stdio: 'pipe' }); } catch { /* already clean */ }
        const stderr = getErrorStderr(err);
        const msg = stderr || errorMessage(err);
        console.error(`[merge] failed:`, msg);
        throw new Error(`Merge failed (conflicts?). Branch ${branchName} was not merged:\n${msg.trim()}`);
      }
    });
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────

  startAgent(
    task: Task,
    onStatusChange: (status: Task['agentStatus'], failure?: string) => void | Promise<void>,
    onWorktreeCreated?: (worktreePath: string) => void | Promise<void>,
  ): void {
    if (this.sessions.has(task.id)) return;

    const agentType = task.agentType || 'copilot';
    const sessionStartTime = Date.now();
    let terminated = false;

    // Clear any prior run's summary so a rerun never displays a stale result
    // (e.g. if this run fails before producing a new summary).
    if (task.summary != null) {
      void this.eventRepo?.update(task.id, { summary: null }).catch(() => {});
    }
    if (task.clarificationRequest != null || task.clarificationAnswer != null) {
      void this.persistTaskClarification(task.id, null, null).catch(() => {});
    }
    this.clarifications.delete(task.id);
    const terminateOnce = async (status: 'complete' | 'failed', errorMessage?: string) => {
      if (terminated) return;
      // If the task was stopped by the user, stopAgent already handled cleanup
      if (this.stoppedTasks.has(task.id)) { terminated = true; return; }
      terminated = true;
      const entry = this.sessions.get(task.id);
      if (entry?.timeoutId) clearTimeout(entry.timeoutId);
      const duration = Date.now() - sessionStartTime;

      // Item 5: Emit structured summary event
      if (status === 'complete') {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'complete',
          content: 'Task completed successfully.',
          timestamp: Date.now(),
          metadata: { agentType, duration },
        });
      } else {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: errorMessage || 'Task failed.',
          timestamp: Date.now(),
          metadata: { agentType, duration, error: errorMessage },
        });
      }

      // Item 2: Broadcast agent_complete WS event
      broadcast({
        type: 'agent_complete',
        payload: {
          taskId: task.id,
          status,
          agentType,
          duration,
          eventCount: (await this.getEvents(task.id)).length,
        },
      });

      await onStatusChange(status, errorMessage);
    };

    const provider = this.providers.get(agentType);
    if (!provider) {
      void terminateOnce('failed', `No provider registered for agent type: ${agentType}`);
      return;
    }

    // Check if agent is available
    const agentInfo = this.availableAgents.find(a => a.name === agentType);
    if (!agentInfo?.available) {
      void terminateOnce('failed', `Agent ${provider.displayName} is not available: ${agentInfo?.reason || 'unknown reason'}`);
      return;
    }

    // Synchronous placeholder to prevent duplicate starts during async session creation
    this.sessions.set(task.id, {
      startTime: sessionStartTime,
      agentType,
      sessionId: null,
      onStatusChange,
    });
    this.syncPowerAssertion();

    // Set up worktree if configured
    let worktreePath: string | undefined;
    if (task.useWorktree) {
      const priorWorktree = task.worktreePath;
      try {
        worktreePath = this.setupWorktree(task);
        if (worktreePath) {
          task.worktreePath = worktreePath;
          if (onWorktreeCreated) onWorktreeCreated(worktreePath);
          const reused = priorWorktree != null && path.resolve(priorWorktree) === path.resolve(worktreePath);
          let dirtyHint = '';
          if (reused) {
            try {
              const status = execFileSync('git', ['status', '--porcelain'], {
                cwd: worktreePath, stdio: 'pipe',
              }).toString().trim();
              dirtyHint = status ? '\nNote: worktree has uncommitted changes from a prior run.' : '';
            } catch {
              /* ignore status probe failures */
            }
          }
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'output',
            content: `${reused ? 'Reusing existing git worktree at' : 'Git worktree created at'} ${worktreePath}\nBranch: ${task.branchName}\nBase: ${task.baseBranch || 'main'}${dirtyHint}`,
            timestamp: Date.now(),
          });
        }
      } catch (err: unknown) {
        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: `Worktree setup failed: ${errorMessage(err)}`,
          timestamp: Date.now(),
        });
        terminateOnce('failed', `Worktree setup failed: ${errorMessage(err)}`);
        return;
      }
    }

    // Launch the agent session asynchronously
    (async () => {
      try {
        const workingDirectory = worktreePath || task.repoPath || process.cwd();
        const hasGit = fs.existsSync(path.join(workingDirectory, '.git'));
        // Sanitize task content to prevent prompt injection via </context> breakout
        const safeTitle = task.title.replace(/[<>]/g, '');
        const systemPrompt = `
<context>
You are a coding agent working on a task in the project directory: ${workingDirectory}
Task: ${safeTitle}
${worktreePath ? `\nIMPORTANT: All file paths MUST be under ${worktreePath}. Do NOT reference or edit files at ${task.repoPath} directly.` : ''}
${!hasGit ? `\nIMPORTANT: This directory is not a git repository. Run \`git init\` first before making any changes, so all work is tracked.` : ''}
Complete the task described in the user prompt. Be thorough — read relevant files,
make precise edits, and verify your changes compile/pass tests when applicable.

If and only if you are blocked by a truly unknown requirement that prevents safe
progress, emit a structured clarification request via event metadata using this
exact contract and then WAIT for the answer before continuing any execution:
clarification_request = {
  "requestId": "stable-unique-id",
  "prompt": "specific blocking question",
  "choices": ["optional", "short", "options"],
  "timestamp": <unix_ms>
}
Rules:
- Use clarification_request only for blocking unknowns; do not ask for non-blocking preferences.
- requestId must be stable and unique for this pending question.
- After emitting clarification_request, stop and wait for the human response.
- Resume only after the clarification answer arrives in this same live session.

When you have finished, end your VERY LAST message with a task summary in EXACTLY this format (keep the tags on their own lines):
<task-summary>
## Completed
A clear description of what you accomplished. This section is required and must not be empty.
## Comments
Optional notes, caveats, decisions, or context. Omit the body if there is nothing to add.
## Remaining
Optional list of any work you did not complete or that should be followed up. Omit the body if everything is done.
</task-summary>
</context>
`;

        // Track file context across tool_execution_start → command_output pairs
        let lastFileEventFile: string | null = null;
        let lastFileEventType: string | null = null;

        // Accumulate assistant prose ('output' events) to extract the agent's
        // end-of-task <task-summary> marker block after completion.
        let summaryBuffer = '';

        const session = await withAgentSecretsRedacted(async () => provider.createSession({
          contextId: task.id,
          workingDirectory,
          repoPath: task.repoPath,
          systemPrompt,
          onEvent: (coreEvent: CoreAgentEvent) => {
            const metadata: Record<string, unknown> = { ...coreEvent.metadata };
            let eventType = coreEvent.type;
            let content = coreEvent.content;

            const hasClarificationMarker = Object.prototype.hasOwnProperty.call(metadata, 'clarification_request');
            const clarificationPayload = parseClarificationRequestPayload(metadata.clarification_request);
            if (hasClarificationMarker && !clarificationPayload) {
              const reason = 'Provider emitted malformed clarification_request payload; refusing to continue without a resumable contract.';
              this.emitEvent(task.id, {
                id: uuid(),
                taskId: task.id,
                type: 'error',
                content: reason,
                timestamp: Date.now(),
              });
              void this.failActiveSession(task.id, reason);
              return;
            }
            if (clarificationPayload) {
              void this.pauseForClarification(task.id, clarificationPayload).catch((err) => {
                const reason = `Failed to pause for clarification: ${errorMessage(err)}`;
                this.emitEvent(task.id, {
                  id: uuid(),
                  taskId: task.id,
                  type: 'error',
                  content: reason,
                  timestamp: Date.now(),
                });
                void this.failActiveSession(task.id, reason);
              });
              return;
            }

            // Accumulate raw assistant prose for summary extraction, then strip
            // the literal sentinel tags so they don't render in the Events tab.
            if (coreEvent.type === 'output') {
              summaryBuffer += content;
              if (summaryBuffer.length > MAX_SUMMARY_BUFFER) {
                summaryBuffer = summaryBuffer.slice(-MAX_SUMMARY_BUFFER);
              }
              if (content.includes('task-summary')) {
                content = content.replace(/<\/?task-summary>/g, '');
              }
            }

            // Reclassify 'create' tool as file_write
            if (coreEvent.type === 'command' && metadata.command === 'create') {
              eventType = 'file_write';
            }

            // Enrich file events with metadata.file extracted from tool arguments
            if ((eventType === 'file_write' || eventType === 'file_edit' || eventType === 'file_read') && !metadata.file) {
              const colonIdx = coreEvent.content.indexOf(':');
              if (colonIdx > 0) {
                try {
                  const args = JSON.parse(coreEvent.content.slice(colonIdx + 1).trim());
                  const filePath = args.path || args.file_path || args.file || args.filename;
                  if (filePath) {
                    metadata.file = filePath;
                    lastFileEventFile = filePath;
                    lastFileEventType = eventType;
                  }
                } catch { /* not JSON args, skip */ }
              }
            }

            // Detect file writes from bash commands (cat > file, echo > file, mkdir, etc.)
            if (coreEvent.type === 'command' && metadata.command === 'bash') {
              const content = coreEvent.content;
              // Match: cat > path, cat >> path, echo ... > path, tee path
              const redirectMatch = content.match(/(?:cat|echo|printf)\s+.*?>\s*(\S+)/);
              const teeMatch = content.match(/tee\s+(\S+)/);
              const filePath = redirectMatch?.[1] || teeMatch?.[1];
              if (filePath && !filePath.startsWith('-')) {
                metadata.file = filePath.replace(/['"]/g, '');
                metadata.fileEventType = 'file_write';
              }
            }

            // Carry file metadata from preceding file_write/file_edit to its command_output
            if (coreEvent.type === 'command_output' && lastFileEventFile && lastFileEventType) {
              metadata.file = lastFileEventFile;
              metadata.fileEventType = lastFileEventType;
              lastFileEventFile = null;
              lastFileEventType = null;
            } else if (eventType !== 'file_write' && eventType !== 'file_edit' && eventType !== 'file_read') {
              lastFileEventFile = null;
              lastFileEventType = null;
            }

            this.emitEvent(task.id, {
              id: coreEvent.id,
              taskId: task.id,
              type: eventType as AgentEvent['type'],
              content,
              timestamp: coreEvent.timestamp,
              metadata,
            });
          },
        }));

        this.sessions.set(task.id, {
          session,
          startTime: sessionStartTime,
          agentType,
          sessionId: session.sessionId,
          onStatusChange,
        });
        this.syncPowerAssertion();
        if (!session.sessionId) {
          await this.failActiveSession(
            task.id,
            `${provider.displayName} provider cannot resume live clarification because it does not expose session.sessionId while execute() is outstanding.`,
          );
          return;
        }
        onStatusChange('executing');

        // Timeout guard. A task override is persisted with the card so retries
        // stay managed by Agent Board instead of escaping to a direct process.
        const taskTimeoutMs = resolveTaskTimeoutMs(task);
        const timeoutId = setTimeout(() => {
          if (!this.sessions.has(task.id)) return;
          const timeoutMsg = `Agent timed out after ${Math.round(taskTimeoutMs / 60000)} minutes`;
          console.warn(`[agent-manager] task ${task.id} timed out after ${taskTimeoutMs}ms`);
          this.emitEvent(task.id, {
            id: uuid(), taskId: task.id, type: 'error',
            content: timeoutMsg,
            timestamp: Date.now(),
          });
          const entry = this.sessions.get(task.id);
          if (entry) {
            this.sessions.delete(task.id);
            this.syncPowerAssertion();
            this.clarifications.delete(task.id);
            entry.session?.abort().catch(() => {});
            entry.session?.destroy().catch(() => {});
          }
          terminateOnce('failed', timeoutMsg);
        }, taskTimeoutMs);

        const entry = this.sessions.get(task.id);
        if (entry) entry.timeoutId = timeoutId;

        // Build prompt and execute — each provider returns a typed AgentResult
        const safeDescription = (task.description || '').replace(/[<>]/g, '');
        const prompt = `${safeTitle}\n\n${safeDescription}`;

        // Load image attachments if available
        let agentAttachments: AgentAttachment[] | undefined;
        if (this.attachmentStore) {
          const taskAttachments = await this.attachmentStore.getByTaskId(task.id);
          if (taskAttachments.length > 0) {
            const loaded: AgentAttachment[] = [];
            for (const a of taskAttachments) {
              const srcPath = path.join(UPLOADS_DIR, a.taskId, a.filename);
              const att = loadAttachmentAsBase64(srcPath, a.originalName, a.mimeType);
              if (att) loaded.push(att);
            }
            if (loaded.length > 0) agentAttachments = loaded;
          }
        }

        console.log(`[agent-manager] executing ${agentType} for task ${task.id}${agentAttachments?.length ? ` with ${agentAttachments.length} image(s)` : ''}`);
        const result = await withAgentSecretsRedacted(async () => session.execute(prompt, agentAttachments));
        console.log(`[agent-manager] ${agentType} ${result.status} for task ${task.id}${result.error ? `: ${result.error}` : ''}`);

        clearTimeout(timeoutId);

        // Primary completion path — status comes from the provider
        if (this.sessions.has(task.id)) {
          const pendingClarification = this.clarifications.get(task.id);
          this.sessions.delete(task.id);
          this.syncPowerAssertion();
          this.clarifications.delete(task.id);
          // On success, persist the agent-authored summary BEFORE the status
          // transition so the task-update broadcast carries it to clients.
          // Always write (extracted value or null) so a rerun can't leave a
          // stale summary from a previous run. Never let this block completion.
          if (result.status === 'complete') {
            try {
              const summary = extractTaskSummary(summaryBuffer);
              await this.eventRepo?.update(task.id, { summary });
            } catch (err) {
              console.error(`[agent-manager] failed to persist summary for task ${task.id}:`, errorMessage(err));
            }
          }
          if (pendingClarification && !pendingClarification.answer) {
            terminateOnce('failed', `Provider completed while clarification ${pendingClarification.request.requestId} remained unanswered.`);
          } else {
            terminateOnce(result.status, result.error);
          }
          session.destroy().catch(() => {});
        }
      } catch (err: unknown) {
        const message = errorMessage(err);
        console.error(`[agent-manager] createSession failed for task ${task.id}: ${errorMessageWithCause(err)}`);
        const isCliMissing =
          message.includes('ENOENT') ||
          message.includes('not found') ||
          message.includes('spawn');

        const errorContent = isCliMissing
          ? `${provider.displayName} CLI is not installed or not found in PATH.`
          : `Failed to start ${provider.displayName} session: ${message}`;

        this.emitEvent(task.id, {
          id: uuid(), taskId: task.id, type: 'error',
          content: errorContent,
          timestamp: Date.now(),
        });

      const entry = this.sessions.get(task.id);
      if (entry) {
        this.sessions.delete(task.id);
        this.syncPowerAssertion();
        this.clarifications.delete(task.id);
      }
      terminateOnce('failed', errorContent);
    }
    })().catch((err: unknown) => {
      console.error(`[agent-manager] unhandled error for task ${task.id}:`, err);
      terminateOnce('failed');
    });
  }

  async sendMessage(taskId: string, message: string, attachmentIds?: string[]): Promise<boolean> {
    if (this.clarifications.has(taskId)) return false;
    const entry = this.sessions.get(taskId);
    if (!entry?.session) return false;
    const activeSession = entry.session;

    this.emitEvent(taskId, {
      id: uuid(), taskId, type: 'command',
      content: `Follow-up message sent: ${message}${attachmentIds?.length ? ` (with ${attachmentIds.length} image(s))` : ''}`,
      timestamp: Date.now(),
    });

    // Load attachments if IDs provided
    let agentAttachments: AgentAttachment[] | undefined;
    if (attachmentIds?.length && this.attachmentStore) {
      const loaded: AgentAttachment[] = [];
      for (const id of attachmentIds) {
        const a = await this.attachmentStore.getById(id);
        if (!a) continue;
        const srcPath = path.join(UPLOADS_DIR, a.taskId, a.filename);
        const att = loadAttachmentAsBase64(srcPath, a.originalName, a.mimeType);
        if (att) loaded.push(att);
      }
      if (loaded.length > 0) agentAttachments = loaded;
    }

    try {
      await withAgentSecretsRedacted(async () => activeSession.send(message, agentAttachments));
    } catch (err: unknown) {
      const providerName = this.providers.get(entry.agentType)?.displayName || entry.agentType;
      throw new Error(`${providerName} failed to process follow-up: ${errorMessage(err)}`);
    }
    return true;
  }

  async stopAgent(taskId: string): Promise<boolean> {
    const entry = this.sessions.get(taskId);
    if (!entry) return false;

    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    const duration = Date.now() - entry.startTime;
    const { agentType } = entry;
    this.sessions.delete(taskId);
    this.syncPowerAssertion();
    this.clarifications.delete(taskId);
    // Mark as stopped so terminateOnce (from the catch block) won't double-broadcast
    this.markStoppedTask(taskId);

    (async () => {
      try { await entry.session?.abort(); } catch {}
      try { await entry.session?.destroy(); } catch {}
    })();

    this.emitEvent(taskId, {
      id: uuid(), taskId, type: 'error',
      content: 'Agent stopped by user.',
      timestamp: Date.now(),
      metadata: { agentType, duration, error: 'Agent stopped by user.' },
    });

    // Broadcast agent_complete so WS listeners know the agent finished
    broadcast({
      type: 'agent_complete',
      payload: {
        taskId,
        status: 'failed',
        agentType,
        duration,
        eventCount: (await this.getEvents(taskId)).length,
      },
    });

    for (const [groupId, q] of this.groupQueues) {
      const wasTracked = q.runningTaskIds.has(taskId) || q.awaitingTaskIds.has(taskId);
      if (wasTracked) {
        q.runningTaskIds.delete(taskId);
        q.awaitingTaskIds.delete(taskId);
        q.failedTaskIds.add(taskId);
        Promise.resolve(q.onChildComplete(taskId)).catch((err: unknown) =>
          console.error('[group] onChildComplete failed:', err),
        );
        if (q.pendingTaskIds.length === 0 && q.runningTaskIds.size === 0 && q.awaitingTaskIds.size === 0) {
          this.groupQueues.delete(groupId);
        } else {
          queueMicrotask(() => this.drainGroupQueue(groupId));
        }
        break;
      }
    }

    return true;
  }

  isRunning(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  shutdownAll(): void {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    this.syncPowerAssertion();
    this.clarifications.clear();

    for (const [, entry] of entries) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      (async () => {
        try { await entry.session?.abort(); } catch {}
        try { await entry.session?.destroy(); } catch {}
      })();
    }

    for (const provider of this.providers.values()) {
      provider.stop().catch(() => {});
    }
  }

  // ─── Group Queue ──────────────────────────────────────────────────

  isGroupRunning(groupId: string): boolean {
    return this.groupQueues.has(groupId);
  }

  startGroup(
    group: TaskGroup,
    children: Task[],
    makeStatusCb: (task: Task) => (status: Task['agentStatus'], failure?: string) => void | Promise<void>,
    makeWorktreeCb: (task: Task) => (worktreePath: string) => void | Promise<void>,
    onChildComplete: (taskId: string) => void | Promise<void>,
  ): void {
    if (this.groupQueues.has(group.id)) return;

    const queue: GroupQueue = {
      groupId: group.id,
      maxConcurrency: group.maxConcurrency,
      pendingTaskIds: children.map((c) => c.id),
      runningTaskIds: new Set(),
      awaitingTaskIds: new Set(),
      completedTaskIds: new Set(),
      failedTaskIds: new Set(),
      tasks: new Map(children.map((c) => [c.id, c])),
      makeStatusCallback: makeStatusCb,
      makeWorktreeCallback: makeWorktreeCb,
      onChildComplete,
      resumeReacquireChain: Promise.resolve(),
    };

    this.groupQueues.set(group.id, queue);
    this.drainGroupQueue(group.id);
  }

  private drainGroupQueue(groupId: string): void {
    const queue = this.groupQueues.get(groupId);
    if (!queue) return;

    // Use queueMicrotask to avoid reentrancy issues when startAgent
    // synchronously calls onStatusChange('failed') for unavailable agents
    const startNext = () => {
      const q = this.groupQueues.get(groupId);
      if (!q) return;
      if (q.runningTaskIds.size >= q.maxConcurrency || q.pendingTaskIds.length === 0) return;

      const taskId = q.pendingTaskIds.shift()!;
      const task = q.tasks.get(taskId);
      if (!task) { startNext(); return; }

      q.runningTaskIds.add(taskId);

      const originalStatusCb = q.makeStatusCallback(task);
      const wrappedStatusCb = async (status: Task['agentStatus'], failure?: string) => {
        // Await status persistence so DB is consistent before completion check
        await originalStatusCb(status, failure);

        if (status === 'awaiting_clarification') {
          q.runningTaskIds.delete(taskId);
          q.awaitingTaskIds.add(taskId);
          queueMicrotask(() => this.drainGroupQueue(groupId));
          return;
        }

        if (status === 'executing' && q.awaitingTaskIds.has(taskId)) {
          q.resumeReacquireChain = q.resumeReacquireChain.then(() => {
            const current = this.groupQueues.get(groupId);
            if (!current || !current.awaitingTaskIds.has(taskId)) return;
            current.awaitingTaskIds.delete(taskId);
            // Never blocks: reacquires a slot immediately even if this
            // temporarily exceeds maxConcurrency by one (see group design).
            current.runningTaskIds.add(taskId);
          }).catch((err: unknown) => {
            console.error('[group] resume reacquire failed:', err);
          });
          await q.resumeReacquireChain;
          return;
        }

        if (status === 'complete' || status === 'failed') {
          q.runningTaskIds.delete(taskId);
          q.awaitingTaskIds.delete(taskId);
          if (status === 'complete') {
            q.completedTaskIds.add(taskId);
          } else {
            q.failedTaskIds.add(taskId);
          }

          // Notify completion (catch to prevent unhandled rejection crash)
          Promise.resolve(q.onChildComplete(taskId)).catch((err: unknown) =>
            console.error('[group] onChildComplete failed:', err),
          );

          // Clean up queue when fully drained
          if (q.pendingTaskIds.length === 0 && q.runningTaskIds.size === 0 && q.awaitingTaskIds.size === 0) {
            this.groupQueues.delete(groupId);
          } else {
            queueMicrotask(() => this.drainGroupQueue(groupId));
          }
        }
      };

      this.startAgent(task, wrappedStatusCb, q.makeWorktreeCallback(task));

      // Start more if we haven't hit concurrency limit
      startNext();
    };

    startNext();
  }

  async stopGroup(groupId: string): Promise<void> {
    const queue = this.groupQueues.get(groupId);
    if (!queue) return;

    // Clear pending
    queue.pendingTaskIds.length = 0;

    const active = [...new Set([...queue.runningTaskIds, ...queue.awaitingTaskIds])];
    for (const taskId of active) {
      await this.stopAgent(taskId);
    }

    this.groupQueues.delete(groupId);
  }
}

export type OpenCodeProviderConfig =
  | { mode: 'managed'; baseUrl: undefined }
  | { mode: 'existing-server'; baseUrl: string };

export function createOpenCodeProviderConfig(env: NodeJS.ProcessEnv = process.env): OpenCodeProviderConfig {
  const baseUrl = resolveOpenCodeBaseUrl(env);
  if (!baseUrl) return { mode: 'managed' as const, baseUrl: undefined };
  return { mode: 'existing-server' as const, baseUrl };
}
