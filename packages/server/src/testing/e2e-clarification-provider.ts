import { randomUUID } from 'node:crypto';
import type {
  AgentAttachment,
  AgentProvider,
  AgentResult,
  AgentSession,
  AgentSessionConfig,
} from '@codewithdan/agent-sdk-core';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const prompt = 'Which branch should I target?';
const choices = ['main', 'develop'];

export class E2EClarificationProvider implements AgentProvider {
  readonly name = 'opencode' as const;
  readonly displayName = 'OpenCode';
  readonly model = 'e2e-clarification-provider';

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = `e2e-clarification-${randomUUID()}`;
    const gate = deferred<void>();
    let aborted = false;
    let answerText = '';

    return {
      sessionId,
      execute: async (_prompt: string, _attachments?: AgentAttachment[]): Promise<AgentResult> => {
        const timestamp = Date.now();
        const clarificationEvent = {
          id: `clarification-${timestamp}`,
          contextId: config.contextId,
          type: 'command',
          content: 'clarification required',
          timestamp,
          metadata: {
            clarification_request: {
              requestId: `req-${timestamp}`,
              prompt,
              choices,
              timestamp,
            },
          },
        } as unknown as Parameters<AgentSessionConfig['onEvent']>[0];
        config.onEvent(clarificationEvent);

        await gate.promise;
        if (aborted) {
          return { status: 'failed', error: 'aborted' };
        }

        const finishedAt = Date.now();
        config.onEvent({
          id: `result-${finishedAt}`,
          contextId: config.contextId,
          type: 'output',
          content: `Clarification answer accepted: ${answerText}\n<task-summary>\n## Completed\nClarification flow resumed in the same session.\n</task-summary>`,
          timestamp: finishedAt,
        });
        return { status: 'complete' };
      },
      send: async (message: string, _attachments?: AgentAttachment[]): Promise<void> => {
        answerText = message;
        gate.resolve(undefined);
      },
      abort: async (): Promise<void> => {
        aborted = true;
        gate.resolve(undefined);
      },
      destroy: async (): Promise<void> => {},
    };
  }
}
