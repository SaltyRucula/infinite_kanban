import type {
  AgentAttachment,
  AgentProvider,
  AgentResult,
  AgentSession,
  AgentSessionConfig,
} from '@codewithdan/agent-sdk-core';
import type { ClarificationRequestPayload } from '../../../../shared/types.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

type DeferredResolve<T> = Deferred<T>['resolve'];

function deferred<T>(): Deferred<T> {
  let resolve: DeferredResolve<T> | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (resolve === undefined) {
    throw new Error('Deferred resolver was not initialized');
  }
  return { promise, resolve };
}

export class TestClarificationProvider implements AgentProvider {
  readonly name = 'opencode' as const;
  readonly displayName = 'OpenCode';
  readonly model = 'test-clarification-provider';

  private sequence = 0;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = `session-test-clarification-${++this.sequence}`;
    const continueExecution = deferred<void>();
    let aborted = false;
    let answerText = '';

    return {
      sessionId,
      execute: async (_prompt: string, _attachments?: AgentAttachment[]): Promise<AgentResult> => {
        const timestamp = Date.now();
        const requestId = `req-${config.contextId}`;

        const clarificationMetadata: { readonly clarification_request: ClarificationRequestPayload } = {
          clarification_request: {
            requestId,
            prompt: 'Which branch should I target?',
            choices: ['main', 'develop'],
            timestamp,
          },
        };

        const clarificationEvent: Parameters<AgentSessionConfig['onEvent']>[0] = {
          id: `clarification-${requestId}`,
          contextId: config.contextId,
          type: 'command',
          content: 'Clarification required before continuing execution.',
          timestamp,
          metadata: clarificationMetadata,
        };

        config.onEvent(clarificationEvent);

        await continueExecution.promise;
        if (aborted) {
          return { status: 'failed', error: 'aborted' };
        }

        config.onEvent({
          id: `resumed-${requestId}`,
          contextId: config.contextId,
          type: 'output',
          content: `Resumed with clarification answer: ${answerText}`,
          timestamp: Date.now(),
        });

        return { status: 'complete' };
      },
      send: async (message: string, _attachments?: AgentAttachment[]): Promise<void> => {
        answerText = message;
        continueExecution.resolve(undefined);
      },
      abort: async (): Promise<void> => {
        aborted = true;
        continueExecution.resolve(undefined);
      },
      destroy: async (): Promise<void> => {},
    };
  }
}
