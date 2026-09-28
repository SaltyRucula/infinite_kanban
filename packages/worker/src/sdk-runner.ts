import { v4 as uuid } from 'uuid';
import {
  OpenCodeProvider,
  type AgentEvent as CoreEvent,
  type AgentProvider,
} from '@codewithdan/agent-sdk-core';
import type {
  AgentEvent,
  AgentEventType,
  AgentType,
  WorkerTaskAssignment,
} from '@ai-agent-board/shared/types.js';
import { isValidAgentType } from '@ai-agent-board/shared/constants.js';
import { buildResumeContext, extractInputRequest, INPUT_REQUEST_INSTRUCTIONS } from './input-request.js';
import { buildReviewPrompt, isReviewRun, neutralizeVerdictMarker, REVIEW_SYSTEM_PROMPT, reviewResult } from './review-mode.js';

const SESSION_ERROR_GRACE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export type SdkRunResult = {
  readonly status: 'complete' | 'failed' | 'awaiting_input';
  readonly summary?: string;
  readonly error?: string;
  readonly question?: string;
  readonly reviewVerdict?: 'pass' | 'changes_requested';
};

export type RunningAgentSdkTask = {
  readonly sessionId: string | null;
  readonly baseUrl?: string;
  readonly done: Promise<SdkRunResult>;
  sendMessage(message: string, attachmentIds?: readonly string[]): Promise<void>;
  abort(): Promise<void>;
};

type RunAgentSdkTaskInput = {
  readonly task: WorkerTaskAssignment;
  readonly workingDirectory: string;
  readonly sendEvent: (event: AgentEvent) => Promise<void>;
  readonly providerFactory?: (agentType: AgentType) => AgentProvider;
};

type WorkerEventMetadata = NonNullable<AgentEvent['metadata']>;

const VALID_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set([
  'thinking',
  'tool_call',
  'file_read',
  'file_write',
  'file_edit',
  'command',
  'command_output',
  'output',
  'test_result',
  'error',
  'complete',
]);

function sanitizeLocalText(content: string, workspacePath: string): string {
  // Guard against an empty workspacePath: String.replaceAll('', x) inserts x
  // between every character instead of doing nothing (see the identical
  // guard in reviewResult, review-mode.ts).
  return workspacePath ? content.replaceAll(workspacePath, '[local workspace]') : content;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function sanitizeMetadata(
  metadata: CoreEvent['metadata'] | undefined,
  workspacePath: string,
): AgentEvent['metadata'] | undefined {
  const record = asRecord(metadata);
  if (!record) return undefined;
  const result: AgentEvent['metadata'] = {};
  const file = typeof record.file === 'string' ? sanitizeLocalText(record.file, workspacePath) : undefined;
  if (file) result.file = file;
  const fileEventType = typeof record.fileEventType === 'string' ? record.fileEventType : undefined;
  if (fileEventType) result.fileEventType = fileEventType;
  const language = typeof record.language === 'string' ? record.language : undefined;
  if (language) result.language = language;
  const command = typeof record.command === 'string' ? sanitizeLocalText(record.command, workspacePath) : undefined;
  if (command) result.command = command;
  const diff = typeof record.diff === 'string' ? sanitizeLocalText(record.diff, workspacePath) : undefined;
  if (diff) result.diff = diff;
  if (typeof record.agentType === 'string') {
    result.agentType = record.agentType as WorkerEventMetadata['agentType'];
  }
  if (typeof record.duration === 'number' && Number.isFinite(record.duration)) result.duration = record.duration;
  const error = typeof record.error === 'string' ? sanitizeLocalText(record.error, workspacePath) : undefined;
  if (error) result.error = error;
  if (record.clarification_request) {
    result.clarification_request = record.clarification_request as WorkerEventMetadata['clarification_request'];
  }
  if (record.clarification_answer) {
    result.clarification_answer = record.clarification_answer as WorkerEventMetadata['clarification_answer'];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function getOpenCodeBaseUrl(): string | undefined {
  const baseUrl = process.env.OPENCODE_BASE_URL;
  if (!baseUrl) return undefined;

  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Invalid protocol: ${url.protocol}. Must be http: or https:`);
    }
    const hostname = url.hostname;
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLoopback) {
      throw new Error(`Invalid hostname: ${hostname}. Must be loopback (localhost, 127.0.0.1, or [::1])`);
    }
    if (!url.port) {
      throw new Error('Missing port. OPENCODE_BASE_URL must include an explicit port (e.g., http://localhost:4096)');
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error('OPENCODE_BASE_URL must not include path, query, hash, or userinfo');
    }
    return baseUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid OPENCODE_BASE_URL: ${message}`);
  }
}

function providerFor(agentType: AgentType): AgentProvider {
  if (agentType !== 'opencode') throw new Error(`unsupported agent type: ${agentType}`);
  const baseUrl = getOpenCodeBaseUrl();
  return new OpenCodeProvider(baseUrl ? { baseUrl } : undefined);
}

function maybeOpenCodeBaseUrl(agentType: AgentType): string | undefined {
  if (agentType !== 'opencode') return undefined;
  return getOpenCodeBaseUrl();
}

function coerceEventType(candidate: string): AgentEventType {
  return VALID_EVENT_TYPES.has(candidate as AgentEventType) ? candidate as AgentEventType : 'output';
}

// The vendored CoreEvent shape gives no message/part identity to key on (see
// mapOpenCodeEvent in @codewithdan/agent-sdk-core: every event gets a fresh
// random uuid, and tool state completions never carry the id of the text
// part they may race with), so the accumulated `verdictText` below spans the
// entire single-turn run — mirroring what local-runner.ts gets "for free"
// from the raw HTTP response's parts array (which also includes every text
// part emitted during the turn, not just a literal last fragment). An
// earlier version of this scoped the scan by resetting on any tool/file
// event, but tool "completed" state and `patch` events (message
// finalization) can legitimately arrive AFTER the final assistant text —
// resetting on those wiped a real verdict and reintroduced the original
// "no verdict" failure through a new mechanism. Never resetting is safe here
// because the actual injection vector this was guarding against (raw task
// title/labels echoed into the prompt) is now neutralized at the source
// (see review-mode.ts's neutralizeVerdictMarker and its callers), and
// extractReviewVerdict's conflict handling (see review-mode.ts) is fail-safe
// against a stray marker-shaped line appearing earlier in the same turn.
function mergeOutput(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  // The real duplication source: `content: delta || part.text` can emit a
  // full-text snapshot instead of a true delta (e.g. the fallback path when
  // SSE delivers no incremental delta for a part). Detect a
  // growing/duplicate snapshot — incoming already contains everything
  // accumulated so far — and replace rather than concatenate, so the same
  // text is never doubled into the buffer.
  if (incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming)) return current;
  return current + incoming;
}

export async function runAgentSdkTask(input: RunAgentSdkTaskInput): Promise<SdkRunResult> {
  const running = await startAgentSdkTask(input);
  return running.done;
}

export async function startAgentSdkTask(input: RunAgentSdkTaskInput): Promise<RunningAgentSdkTask> {
  const agentType = input.task.agentType;
  if (!agentType || !isValidAgentType(agentType)) {
    throw new Error('task has no supported agentType');
  }

  const provider = (input.providerFactory ?? providerFor)(agentType);
  await provider.start();

  // The underlying provider's `execute()` can resolve with status 'complete'
  // even when the session never produced real work (observed: an internal
  // server error that isn't reflected in the response's `info.error` field).
  // Track any 'error'-type event independently via the same onEvent stream
  // the provider already emits, so a false "complete" can be overridden.
  let sessionErrorMessage: string | undefined;
  let resolveSessionError: (message: string) => void = () => {};
  const sessionErrorSignal = new Promise<string>((resolve) => { resolveSessionError = resolve; });

  const review = isReviewRun(input.task);

  // Two independently-shaped buffers are kept over the same onEvent stream
  // because the review-verdict scan and the clarification-question scan need
  // different accumulation semantics, and reading one scan off the other's
  // buffer shape would corrupt it (see the two comments below).
  //
  // `verdictText` accumulates across the WHOLE turn (never reset at tool/file
  // event boundaries), deduped against snapshot resends via mergeOutput. See
  // mergeOutput's comment above for why this never resets: tool "completed"
  // state and `patch` events (message finalization) can legitimately arrive
  // AFTER the final assistant text, and resetting on those would wipe a real
  // verdict.
  let verdictText = '';

  // `burstText` mirrors the OLD scoped-reset behavior instead: output streams
  // as deltas or whole-part snapshots for a single evolving assistant
  // message, so this can repeat text within one message — it is only scanned
  // for the input-request marker, never shown to anyone. Any OTHER event
  // type between bursts of 'output' events (tool call, thinking, etc.) marks
  // the end of that message, so the buffer is reset there too: otherwise it
  // would accumulate every assistant message across the whole run, and the
  // marker text baked into this session's own system prompt
  // (INPUT_REQUEST_INSTRUCTIONS) could be picked up from an earlier turn that
  // merely recapped it, false-parking already-finished work.
  //
  // The provider's execute() resolves on a synthetic 'complete' event, and
  // sdk-runner then waits SESSION_ERROR_GRACE_MS before reading the buffer —
  // but the SSE event stream can lag that resolution by a beat (documented
  // in local-runner.ts's own grace-period handling around the same race), so
  // an unrelated trailing 'output' fragment can arrive AFTER the real final
  // message's burst already closed and was evaluated. If that straggler
  // doesn't itself contain the marker, resetting to it and reading only the
  // final buffer would silently lose the genuine question that was already
  // detected in the previous, now-discarded burst. lastDetectedQuestion
  // remembers the last NON-EMPTY per-burst extraction result so a later,
  // unrelated empty burst can never erase it.
  let burstText = '';
  let lastEventType: CoreEvent['type'] | undefined;
  let lastDetectedQuestion: string | undefined;

  const session = await provider.createSession({
    contextId: input.task.id,
    workingDirectory: input.workingDirectory,
    systemPrompt: 'Work in the locally configured workspace. Follow the workspace instructions and skills. '
      + `${INPUT_REQUEST_INSTRUCTIONS} `
      + (review ? `${REVIEW_SYSTEM_PROMPT} ` : '')
      // On the review path the title is untrusted task text (e.g. Jira
      // import) interpolated into the system prompt itself; neutralize it
      // the same way buildReviewPrompt neutralizes title/description/labels
      // in the user prompt, or an injected marker here could be echoed back
      // by the model and picked up by the verdict scan.
      + `Task title: ${review ? neutralizeVerdictMarker(input.task.title) : input.task.title}`,
    onEvent: (event: CoreEvent) => {
      const type = coerceEventType(event.type);
      // Only accumulate genuine 'output' events into either scan buffer,
      // checked against the raw (uncoerced) event.type. Widening an
      // unrecognized/off-spec type to 'output' is a reasonable default for
      // *display* purposes (below), but doing the same for the buffers that
      // feed the review/clarification scans would be backwards: an off-spec
      // event should be excluded from scanning, not folded in as if it were
      // real assistant text.
      if (event.type === 'output') {
        verdictText = event.metadata?.replace ? event.content : mergeOutput(verdictText, event.content);

        if (lastEventType !== undefined && lastEventType !== 'output') {
          const question = extractInputRequest(burstText);
          if (question) lastDetectedQuestion = question;
          burstText = '';
        }
        burstText += event.content;
      }
      lastEventType = event.type;
      const metadata = sanitizeMetadata(event.metadata, input.workingDirectory);
      const mapped: AgentEvent = {
        id: event.id || uuid(),
        taskId: input.task.id,
        type,
        content: sanitizeLocalText(event.content, input.workingDirectory),
        timestamp: event.timestamp,
        ...(metadata ? { metadata } : {}),
      };
      if (mapped.type === 'error' && sessionErrorMessage === undefined) {
        sessionErrorMessage = mapped.content || 'agent session reported an error';
        resolveSessionError(sessionErrorMessage);
      }
      void input.sendEvent(mapped).catch((error: unknown) => {
        console.error(`[worker] event upload failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await session.destroy();
    await provider.stop();
  };

  const done = (async (): Promise<SdkRunResult> => {
    try {
      // The provider deletes its sessions on cleanup, so a resumed task starts
      // a fresh session carrying the question and answer as context. A run
      // started from Review takes precedence over resume — the two are
      // mutually exclusive on any single run (see the module comment on
      // startAgentSdkTask's two buffers).
      const prompt = review
        ? buildReviewPrompt(input.task)
        : `${input.task.title}\n\n${input.task.description}`
          + (input.task.resume ? `\n\n${buildResumeContext(input.task.resume)}` : '');
      const result = await session.execute(prompt);
      if (result.status === 'complete') {
        const late = await Promise.race([
          sessionErrorSignal.then((message) => ({ message })),
          sleep(SESSION_ERROR_GRACE_MS).then(() => undefined),
        ]);
        if (late) {
          return { status: 'failed', summary: 'Agent SDK task failed', error: late.message };
        }
        if (review) return reviewResult(verdictText, input.workingDirectory);
        const question = extractInputRequest(burstText) ?? lastDetectedQuestion;
        if (question) {
          return {
            status: 'awaiting_input',
            question: sanitizeLocalText(question, input.workingDirectory),
            summary: 'Agent SDK task is waiting for input',
          };
        }
        return {
          status: 'complete',
          summary: 'Agent SDK task completed',
        };
      }
      return {
        status: 'failed',
        summary: 'Agent SDK task failed',
        ...(result.error ? { error: sanitizeLocalText(result.error, input.workingDirectory) } : {}),
      };
    } catch (error: unknown) {
      return {
        status: 'failed',
        summary: 'Agent SDK task failed',
        error: sanitizeLocalText(error instanceof Error ? error.message : String(error), input.workingDirectory),
      };
    } finally {
      await cleanup();
    }
  })();

  return {
    sessionId: session.sessionId ?? null,
    ...(maybeOpenCodeBaseUrl(agentType) ? { baseUrl: maybeOpenCodeBaseUrl(agentType) } : {}),
    done,
    sendMessage: async (message: string, _attachmentIds?: readonly string[]) => {
      verdictText = '';
      burstText = '';
      lastDetectedQuestion = undefined;
      await session.send(message);
    },
    abort: async () => {
      await session.abort();
    },
  };
}
