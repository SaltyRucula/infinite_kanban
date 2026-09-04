import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeProvider } from '@codewithdan/agent-sdk-core';
import type { AgentSessionConfig } from '@codewithdan/agent-sdk-core';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PromptRequestBody {
  readonly parts: readonly Array<{ readonly type: 'text'; readonly text: string }>;
  readonly system?: string;
}

interface PromptInvocation {
  readonly id: string;
  readonly body: PromptRequestBody;
  readonly response: Deferred<{ readonly data?: { readonly parts?: readonly unknown[] } }>;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('clarification probe: OpenCode provider session.send can run while execute is still in-flight', async () => {
  const prompts: PromptInvocation[] = [];
  const deletedSessionIds: string[] = [];

  const fakeClient = {
    session: {
      async create(): Promise<{ data: { id: string } }> {
        return { data: { id: 'session-42' } };
      },
      async get(): Promise<{ data: null }> {
        return { data: null };
      },
      async prompt(input: { path: { id: string }; body: PromptRequestBody }): Promise<{ readonly data?: { readonly parts?: readonly unknown[] } }> {
        const entry: PromptInvocation = {
          id: input.path.id,
          body: input.body,
          response: deferred<{ readonly data?: { readonly parts?: readonly unknown[] } }>(),
        };
        prompts.push(entry);
        return entry.response.promise;
      },
      async abort(): Promise<void> {},
      async delete(input: { path: { id: string } }): Promise<void> {
        deletedSessionIds.push(input.path.id);
      },
    },
    event: {
      async subscribe(): Promise<{ stream: AsyncGenerator<never, void, unknown> }> {
        return {
          async *stream() {
            return;
          },
        };
      },
    },
  };

  const provider = new OpenCodeProvider({ baseUrl: 'http://127.0.0.1:4096' });
  (provider as unknown as { client: unknown }).client = fakeClient;

  const config: AgentSessionConfig = {
    contextId: 'ctx-clarification-probe',
    workingDirectory: process.cwd(),
    systemPrompt: 'system prompt',
    onEvent: () => {},
  };

  const session = await provider.createSession(config);

  const executePromise = session.execute('primary prompt');
  await waitFor(() => prompts.length === 1);

  const sendPromise = session.send('clarification answer');
  await waitFor(() => prompts.length === 2);

  assert.equal(prompts[0].id, 'session-42');
  assert.equal(prompts[1].id, 'session-42');
  assert.equal(prompts[0].body.parts[0]?.text, 'primary prompt');
  assert.equal(prompts[1].body.parts[0]?.text, 'clarification answer');

  prompts[1].response.resolve({ data: { parts: [] } });
  await sendPromise;

  prompts[0].response.resolve({ data: { parts: [] } });
  const executeResult = await executePromise;
  assert.equal(executeResult.status, 'complete');

  await session.destroy();
  assert.deepEqual(deletedSessionIds, ['session-42']);
});
