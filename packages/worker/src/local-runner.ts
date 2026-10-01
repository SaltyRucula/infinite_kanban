import { v4 as uuid } from 'uuid';
import type { AgentEvent as CoreEvent } from '@codewithdan/agent-sdk-core';
import {
  createV1Adapter,
  createV2Adapter,
  spawnOpenCodeServer,
  type OpenCodeAdapter,
  type OpenCodeProcessLike,
  type OpenCodeSpawnFn,
  type SessionSpec,
  type TurnOpts,
  type TurnResult,
} from '@ai-agent-board/opencode-compat';
import type { AgentEvent, ReviewVerdict, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import { buildResumeAnswerPrompt, buildResumeContext, extractInputRequest, INPUT_REQUEST_INSTRUCTIONS } from './input-request.js';
import { buildReviewPrompt, isReviewRun, REVIEW_DISABLED_TOOLS, REVIEW_SYSTEM_PROMPT, reviewResult } from './review-mode.js';

export type AgentSdkRunnerProfile = { readonly kind: 'agent-sdk' };
export type OpenCodeServerRunnerProfile = { readonly kind: 'opencode-server'; readonly agent: string };
export type RunnerProfile = AgentSdkRunnerProfile | OpenCodeServerRunnerProfile;
export type WorkspaceSettings = { readonly workspacePath: string; readonly runner: RunnerProfile };
export type OpenCodeRunResult = {
  readonly status: 'complete' | 'failed' | 'awaiting_input';
  readonly summary?: string;
  readonly error?: string;
  readonly question?: string;
  readonly reviewVerdict?: ReviewVerdict;
};

export type LiveOpenCodeServerTask = {
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly done: Promise<OpenCodeRunResult>;
  sendMessage(message: string, attachmentIds?: readonly string[]): Promise<void>;
  abort(): Promise<void>;
  shutdown(): Promise<void>;
};

// Re-exported under the pre-adapter name so callers/tests that only care
// about "a spawned opencode process handle" don't need to know the compat
// package's type name.
export type OpenCodeProcess = OpenCodeProcessLike;
export type OpenCodeSpawn = OpenCodeSpawnFn;

/**
 * Builds an `OpenCodeAdapter` for a given server connection. Test seam:
 * inject a fake adapter instead of talking to a real opencode server.
 *
 * `apiVersion`/`password` are populated by `startOpenCodeServerTask`'s real
 * spawn path (see `spawnOpenCodeServer`'s `apiVersion` probe result) so the
 * default factory below can select `createV1Adapter` vs `createV2Adapter`
 * without guessing. Both are left `undefined` on the "attach to an
 * already-running server" path (`input.baseUrl` supplied directly, used
 * only by tests today — see `startOpenCodeServerTask`) since that path
 * never spawns or probes; `defaultCreateAdapter` falls back to v1 there,
 * matching this build's behaviour before this seam existed.
 */
export type CreateOpenCodeAdapter = (input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly apiVersion?: 1 | 2;
  readonly password?: string;
}) => OpenCodeAdapter;

type StartOpenCodeServerTaskInput = {
  readonly task: WorkerTaskAssignment;
  readonly workspacePath: string;
  readonly runner: OpenCodeServerRunnerProfile;
  readonly sendEvent: (event: AgentEvent) => Promise<void>;
  readonly spawnFn?: OpenCodeSpawn;
  readonly createAdapter?: CreateOpenCodeAdapter;
  readonly baseUrl?: string;
  readonly managedServer?: OpenCodeProcess;
};

const DEFAULT_SERVER_HOSTNAME = '127.0.0.1';
const DEFAULT_SERVER_PORT = 0;
const SESSION_ERROR_GRACE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function sanitizeLocalText(content: string, workspacePath: string): string {
  // Guard against an empty workspacePath: String.replaceAll('', x) inserts x
  // between every character instead of doing nothing (see the identical
  // guard in reviewResult, review-mode.ts).
  return workspacePath ? content.replaceAll(workspacePath, '[local workspace]') : content;
}

function sanitizeMetadata(
  metadata: CoreEvent['metadata'] | undefined,
  workspacePath: string,
): AgentEvent['metadata'] | undefined {
  type WorkerMetadata = NonNullable<AgentEvent['metadata']>;
  const record = asRecord(metadata);
  if (!record) return undefined;
  const result: WorkerMetadata = {};
  if (typeof record.file === 'string') result.file = sanitizeLocalText(record.file, workspacePath);
  if (typeof record.fileEventType === 'string') result.fileEventType = record.fileEventType;
  if (typeof record.language === 'string') result.language = record.language;
  if (typeof record.command === 'string') result.command = sanitizeLocalText(record.command, workspacePath);
  if (typeof record.diff === 'string') result.diff = sanitizeLocalText(record.diff, workspacePath);
  if (typeof record.agentType === 'string') result.agentType = record.agentType as WorkerMetadata['agentType'];
  if (typeof record.duration === 'number' && Number.isFinite(record.duration)) result.duration = record.duration;
  if (typeof record.error === 'string') result.error = sanitizeLocalText(record.error, workspacePath);
  if (record.clarification_request) {
    result.clarification_request = record.clarification_request as WorkerMetadata['clarification_request'];
  }
  if (record.clarification_answer) {
    result.clarification_answer = record.clarification_answer as WorkerMetadata['clarification_answer'];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mapCoreEvent(taskId: string, workspacePath: string, event: CoreEvent): AgentEvent {
  const metadata = sanitizeMetadata(event.metadata, workspacePath);
  return {
    id: event.id || uuid(),
    taskId,
    type: event.type,
    content: sanitizeLocalText(event.content, workspacePath),
    timestamp: event.timestamp,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Selects `createV1Adapter` vs `createV2Adapter` from `spawnOpenCodeServer`'s
 * `apiVersion` probe result (see `CreateOpenCodeAdapter`'s doc comment).
 * `apiVersion` is only ever `2` when a real spawn positively identified a
 * v2+ server via `/api/info` — see spawn.ts — so `password` is guaranteed
 * present alongside it in that branch (both come from the same
 * `SpawnedOpenCodeServer` handle); the thrown error below is a defensive
 * backstop for a hand-rolled `apiVersion: 2` call site, not a path any real
 * spawn can reach.
 */
function defaultCreateAdapter(input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly apiVersion?: 1 | 2;
  readonly password?: string;
}): OpenCodeAdapter {
  if (input.apiVersion === 2) {
    if (!input.password) {
      throw new Error('opencode v2 server detected but no server password was supplied to the adapter factory');
    }
    return createV2Adapter({ baseUrl: input.baseUrl, directory: input.directory, password: input.password });
  }
  return createV1Adapter({ baseUrl: input.baseUrl, directory: input.directory });
}

// The native `question` tool is a TUI-only interactive feature: when invoked
// headlessly there is nothing to answer it (the OpenCode server SDK exposes no
// "respond to this tool call" endpoint), so the tool call just hangs until the
// HTTP request client-side times out, surfacing as an opaque "fetch failed"
// failure with no real work done. Disable it for headless worker runs and
// instruct the agent to ask via plain text instead, so a missing-information
// case completes quickly and visibly rather than hanging/failing.
const HEADLESS_DISABLED_TOOLS: Readonly<Record<string, boolean>> = { question: false };

const HEADLESS_CLARIFICATION_SYSTEM_PROMPT = [
  'You are running headlessly with no interactive user available during this turn.',
  'The `question` tool is disabled and cannot be used — do not attempt to call it.',
  'Your workspace root may contain multiple sibling repositories. Identify which repository',
  'this task targets (match the task title/description against the directory names under your',
  'root), then work inside that repository. If no repository under your root matches this task,',
  'do NOT guess — stop and end your response clearly stating which repository you expected and',
  'that it is not present, so a human can route the task to a worker that has it.',
].join(' ');

// OpenCode gates file access outside the session root behind an interactive
// `external_directory` permission prompt (and can also gate edit/bash). A
// headless worker has nobody to answer these, so the session silently blocks
// until the HTTP client times out — the true cause of the "stalls" we chased.
// Inject a non-interactive permission ruleset via OPENCODE_PERMISSION (parsed
// by `opencode serve` into its permission config) so the session never waits
// on a prompt. The session root is set to the worker's configured workspace,
// so legitimate repo work is in-bounds; "allow" here only guarantees liveness
// for the rare out-of-root access instead of an indefinite hang.
const HEADLESS_PERMISSION_ENV = JSON.stringify({
  edit: 'allow',
  bash: 'allow',
  webfetch: 'allow',
  external_directory: 'allow',
});

// Defaults to a GitHub Copilot model (requires `gh`/`copilot` CLI auth on this
// worker's host) instead of OpenCode's bundled free-tier models, which this
// worker's OpenCode CLI version is too old to use. Override via env var if a
// different provider/model should be used.
function headlessModel(): { providerID: string; modelID: string } | undefined {
  const raw = process.env.OPENCODE_WORKER_MODEL?.trim();
  const [providerID, modelID] = (raw || 'github-copilot/claude-sonnet-5').split('/');
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

const STALL_TIMEOUT_MS = 60_000;
const STALL_CHECK_INTERVAL_MS = 2_000;
const MAX_STALL_RETRIES = 2;

const STALL_RETRY_NUDGE =
  'The previous step appears to have stalled (a tool call did not report completion). '
  + 'This is a known infrastructure glitch, not something you did wrong — the tool likely '
  + 'ran fine but its result was never delivered back to you. Do not repeat the exact same '
  + 'command; instead pick up from what you already know from this conversation and continue '
  + 'toward completing the task.';

export function buildTaskPrompt(task: WorkerTaskAssignment): string {
  const labels = task.labels.length > 0 ? task.labels.join(', ') : '(none)';
  return [
    ...(task.project?.goal ? [`Project goal: ${task.project.goal}`, ''] : []),
    ...(task.project?.context ? [`Project context: ${task.project.context}`, ''] : []),
    `Task title: ${task.title}`,
    '',
    `Task description: ${task.description}`,
    '',
    `Labels: ${labels}`,
  ].join('\n');
}

async function resolveSession(
  adapter: OpenCodeAdapter,
  task: WorkerTaskAssignment,
  spec: SessionSpec,
): Promise<{ sessionId: string; firstPrompt: string }> {
  // A review run must never carry `resume`: resolveSession would happily
  // resume the paused session below, but startOpenCodeServerTask always
  // sends buildReviewPrompt (not this function's firstPrompt) into a review
  // run, silently discarding the resume answer and sending a review prompt
  // into a session that was reopened to receive a clarification answer.
  // Nothing produces this combination today — INPUT_REQUEST_INSTRUCTIONS
  // (the only thing that can make a run ask for `resume`) is gated on
  // `!review` — but fail loudly instead of silently mishandling it if that
  // invariant is ever broken.
  if (task.resume && isReviewRun(task)) {
    throw new Error('resolveSession: task.resume must never be set on a review-mode task');
  }
  if (task.resume) {
    // OpenCode persists sessions on disk, so the paused conversation is
    // usually still available even if the server that ran it has exited.
    // Any failure here (not-found, or a transport-level error) falls
    // through to creating a new session below rather than failing the task.
    let existingId: string | null = null;
    try {
      existingId = await adapter.getSession(task.resume.sessionId);
    } catch {
      existingId = null;
    }
    if (existingId) {
      return { sessionId: existingId, firstPrompt: buildResumeAnswerPrompt(task.resume) };
    }
  }
  const sessionId = await adapter.createSession(spec);
  const firstPrompt = task.resume
    ? `${buildTaskPrompt(task)}\n\n${buildResumeContext(task.resume)}`
    : buildTaskPrompt(task);
  return { sessionId, firstPrompt };
}

export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const record = asRecord(raw);
  const workspacePath = typeof record?.workspacePath === 'string' ? record.workspacePath.trim() : '';
  if (!workspacePath) {
    throw new Error('worker workspace configuration must include workspacePath');
  }

  const rawRunner = record?.runner;
  if (rawRunner === undefined) {
    return { workspacePath, runner: { kind: 'agent-sdk' } };
  }

  const runnerRecord = asRecord(rawRunner);
  const kind = typeof runnerRecord?.kind === 'string' ? runnerRecord.kind : '';
  if (kind === 'agent-sdk') {
    return { workspacePath, runner: { kind: 'agent-sdk' } };
  }
  if (kind === 'opencode-server') {
    const agent = typeof runnerRecord?.agent === 'string' ? runnerRecord.agent.trim() : '';
    if (!agent) {
      throw new Error('runner.agent must be a non-empty string when runner.kind is opencode-server');
    }
    return { workspacePath, runner: { kind: 'opencode-server', agent } };
  }
  throw new Error('runner.kind must be either "agent-sdk" or "opencode-server"');
}

export async function startOpenCodeServerTask(input: StartOpenCodeServerTaskInput): Promise<LiveOpenCodeServerTask> {
  const createAdapter = input.createAdapter ?? defaultCreateAdapter;

  if (input.baseUrl) {
    // Caller already has a running server (and optionally a `managedServer`
    // handle for later shutdown()/abort() lifecycle control) — never spawn
    // or version-probe in this branch, so apiVersion/password are unknown
    // here; defaultCreateAdapter falls back to v1 (see its doc comment).
    return startOpenCodeServerTaskWithAdapter({
      ...input,
      baseUrl: input.baseUrl,
      managedServer: input.managedServer,
      createAdapter,
    });
  }

  const spawned = await spawnOpenCodeServer({
    hostname: DEFAULT_SERVER_HOSTNAME,
    port: DEFAULT_SERVER_PORT,
    spawnFn: input.spawnFn,
    existingProcess: input.managedServer,
    spawnOptions: { shell: false },
    env: { OPENCODE_PERMISSION: HEADLESS_PERMISSION_ENV },
  });
  return startOpenCodeServerTaskWithAdapter({
    ...input,
    baseUrl: spawned.baseUrl,
    managedServer: spawned.process,
    apiVersion: spawned.apiVersion,
    password: spawned.serverPassword,
    createAdapter,
  });
}

type StartOpenCodeServerTaskWithAdapterInput = StartOpenCodeServerTaskInput & {
  readonly baseUrl: string;
  readonly managedServer: OpenCodeProcess | undefined;
  readonly createAdapter: CreateOpenCodeAdapter;
  readonly apiVersion?: 1 | 2;
  readonly password?: string;
};

async function startOpenCodeServerTaskWithAdapter(input: StartOpenCodeServerTaskWithAdapterInput): Promise<LiveOpenCodeServerTask> {
  const adapter = input.createAdapter({
    baseUrl: input.baseUrl,
    directory: input.workspacePath,
    apiVersion: input.apiVersion,
    password: input.password,
  });
  const review = isReviewRun(input.task);

  // Hoisted per SessionSpec's contract (see opencode-compat/types.ts): this
  // build's v1 adapter treats these purely as defaults available to
  // runTurn's opts fallback. Every runTurn call below passes its own
  // explicit opts instead of relying on that fallback — this task always
  // resends agent/model/tools on every turn regardless of whether the
  // session was freshly created or resumed (a resumed session never calls
  // createSession, so it would have no stored spec to fall back to), which
  // is exactly what the pre-adapter code did.
  const spec: SessionSpec = {
    title: input.task.title,
    directory: input.workspacePath,
    agent: input.runner.agent,
    model: headlessModel(),
    systemPrompt: review
      ? `${HEADLESS_CLARIFICATION_SYSTEM_PROMPT} ${REVIEW_SYSTEM_PROMPT}`
      : HEADLESS_CLARIFICATION_SYSTEM_PROMPT,
    headlessPermissions: true,
    disabledTools: review
      ? { ...HEADLESS_DISABLED_TOOLS, ...REVIEW_DISABLED_TOOLS }
      : HEADLESS_DISABLED_TOOLS,
  };

  const { sessionId, firstPrompt } = await resolveSession(adapter, input.task, spec);

  // `runTurn()` can resolve without throwing even when the server failed
  // internally to process the turn, so a successful `runTurn()` alone
  // cannot prove the turn ran; the SSE `session.error` event (surfaced here
  // as a mapped core event of type 'error') is the reliable signal, tracked
  // here.
  let sessionErrorMessage: string | undefined;
  let resolveSessionError: (message: string) => void = () => {};
  const sessionErrorSignal = new Promise<string>((resolve) => { resolveSessionError = resolve; });

  // Tool calls occasionally never report completion back through the SSE
  // stream (observed independent of CPU load or command complexity — e.g. a
  // `find` that runs in under a second locally still leaves the session
  // "running" indefinitely). `adapter.runTurn()` then blocks until the
  // outer HTTP client times out (~5 minutes) with a generic "fetch failed".
  // Track the last time *any* event arrived so a stall can be detected and
  // retried well before that outer timeout, instead of just failing.
  let lastActivityAt = Date.now();

  const streamAbortController = new AbortController();
  let aborted = false;
  const streamLoop = (async (): Promise<void> => {
    try {
      for await (const coreEvent of adapter.subscribe(sessionId, streamAbortController.signal)) {
        lastActivityAt = Date.now();
        const mapped = mapCoreEvent(input.task.id, input.workspacePath, coreEvent);
        if (mapped.type === 'error' && sessionErrorMessage === undefined) {
          sessionErrorMessage = mapped.content || 'opencode session reported an error';
          resolveSessionError(sessionErrorMessage);
        }
        void input.sendEvent(mapped).catch((error: unknown) => {
          console.error(`[worker] event upload failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch {
      return;
    }
  })();

  const abort = async (): Promise<void> => {
    aborted = true;
    streamAbortController.abort();
    await adapter.interrupt(sessionId);
  };

  const shutdown = async (): Promise<void> => {
    aborted = true;
    streamAbortController.abort();
    await adapter.interrupt(sessionId).catch(() => undefined);
    input.managedServer?.kill('SIGTERM');
  };

  const runTurnWithStallRecovery = async (text: string, opts: TurnOpts): Promise<TurnResult> => {
    let attempt = 0;
    let currentText = text;
    for (;;) {
      lastActivityAt = Date.now();
      const turnPromise = adapter.runTurn(sessionId, currentText, opts);
      let stallTimer: ReturnType<typeof setInterval> | undefined;
      const stallPromise = new Promise<'stalled'>((resolve) => {
        stallTimer = setInterval(() => {
          if (Date.now() - lastActivityAt > STALL_TIMEOUT_MS) resolve('stalled');
        }, STALL_CHECK_INTERVAL_MS);
      });
      const outcome = await Promise.race([turnPromise.then((result) => ({ result })), stallPromise]);
      clearInterval(stallTimer);
      if (outcome !== 'stalled') return outcome.result;

      // Stalled: the original runTurn() call is still in flight server-side,
      // but we've given up waiting on it. Swallow whatever it eventually
      // settles with (we've already moved on) so it doesn't surface as an
      // unhandled rejection, then interrupt the turn and retry with a nudge.
      void turnPromise.catch(() => undefined);
      attempt += 1;
      await adapter.interrupt(sessionId).catch(() => undefined);
      if (attempt > MAX_STALL_RETRIES) {
        throw new Error(`OpenCode session stalled with no tool-call progress for over ${STALL_TIMEOUT_MS / 1000}s, even after ${MAX_STALL_RETRIES} retries`);
      }
      currentText = STALL_RETRY_NUDGE;
    }
  };

  const done = (async (): Promise<OpenCodeRunResult> => {
    try {
      const result = await runTurnWithStallRecovery(review ? buildReviewPrompt(input.task) : firstPrompt, {
        agent: input.runner.agent,
        // A review run only ever scans for REVIEW_VERDICT (see reviewResult
        // below), never for a clarification marker — including
        // INPUT_REQUEST_INSTRUCTIONS here as well would hand the reviewer two
        // contradictory "end your response with this final line" instructions.
        // A reviewer that needs more information should express that as
        // changes_requested with the question in its findings instead.
        systemPrompt: review
          ? `${HEADLESS_CLARIFICATION_SYSTEM_PROMPT} ${REVIEW_SYSTEM_PROMPT}`
          : `${HEADLESS_CLARIFICATION_SYSTEM_PROMPT} ${INPUT_REQUEST_INSTRUCTIONS}`,
        model: headlessModel(),
        disabledTools: review ? { ...HEADLESS_DISABLED_TOOLS, ...REVIEW_DISABLED_TOOLS } : HEADLESS_DISABLED_TOOLS,
      });
      if (aborted) {
        return { status: 'failed', error: 'opencode session cancelled', summary: 'Cancelled OpenCode session task' };
      }
      // The SSE stream can lag the HTTP response by a beat; race a bounded
      // grace period against sessionErrorSignal so a late `session.error`
      // still overrides a falsely-successful `runTurn()` resolution.
      const late = await Promise.race([
        sessionErrorSignal.then((message) => ({ message })),
        sleep(SESSION_ERROR_GRACE_MS).then(() => undefined),
      ]);
      if (late) {
        return { status: 'failed', error: late.message, summary: 'OpenCode server task failed' };
      }
      if (review) return reviewResult(result.text, input.workspacePath);
      const question = extractInputRequest(result.text);
      if (question) {
        return {
          status: 'awaiting_input',
          question: sanitizeLocalText(question, input.workspacePath),
          summary: 'OpenCode session is waiting for input',
        };
      }
      return { status: 'complete', summary: 'OpenCode server task completed' };
    } catch (error: unknown) {
      const message = sanitizeLocalText(error instanceof Error ? error.message : String(error), input.workspacePath);
      return { status: 'failed', error: message, summary: 'OpenCode server task failed' };
    } finally {
      streamAbortController.abort();
      await streamLoop;
    }
  })();

  return {
    sessionId,
    baseUrl: input.baseUrl,
    done,
    sendMessage: async (message: string, _attachmentIds?: readonly string[]) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      await runTurnWithStallRecovery(trimmed, {
        agent: input.runner.agent,
        model: headlessModel(),
        // Deliberately omit the system prompt on follow-ups: the session
        // already has full context from the first turn, so resending it is
        // unnecessary chatter, not a functional requirement (matches the
        // pre-adapter behaviour exactly).
        systemPrompt: null,
        disabledTools: HEADLESS_DISABLED_TOOLS,
      });
    },
    abort,
    shutdown,
  };
}
