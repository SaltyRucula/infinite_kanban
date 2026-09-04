import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSessionConfig } from '@codewithdan/agent-sdk-core';
import { NonDestructiveOpenCodeProvider } from '../src/opencode/non-destructive-provider.js';

interface PromptCall {
  readonly text: string;
}

function makeConfig(contextId: string): AgentSessionConfig {
  return {
    contextId,
    workingDirectory: process.cwd(),
    systemPrompt: 'system',
    onEvent: () => {},
  };
}

test('NonDestructiveOpenCodeProvider retries transient prompt failure and completes after recovery', async () => {
  const provider = new NonDestructiveOpenCodeProvider({ baseUrl: 'http://127.0.0.1:4098' });
  const promptCalls: PromptCall[] = [];
  let promptAttempts = 0;

  const fakeClient = {
    session: {
      async create(): Promise<{ data: { id: string } }> {
        return { data: { id: 'session-1' } };
      },
      async get(input: { path: { id: string } }): Promise<{ data: { id: string } | null }> {
        return { data: input.path.id === 'session-1' ? { id: 'session-1' } : null };
      },
      async list(): Promise<{ data: Array<{ id: string; title: string; time: { updated: number } }> }> {
        return { data: [] };
      },
      async delete(): Promise<void> {},
      async abort(): Promise<void> {},
      async prompt(input: { path: { id: string }; body: { messageID?: string; parts: Array<{ text: string }> } }): Promise<{ data?: { info?: { error?: { name: string; data?: unknown } } } }> {
        assert.equal(input.body.messageID, undefined, 'must never send messageID: this OpenCode server silently no-ops when it is present');
        promptCalls.push({ text: input.body.parts[0]?.text ?? '' });
        promptAttempts += 1;
        if (promptAttempts === 1) {
          const rootCause = new Error('connect ECONNREFUSED 127.0.0.1:4098');
          throw new TypeError('fetch failed', { cause: rootCause });
        }
        return { data: {} };
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

  (provider as unknown as { client: unknown }).client = fakeClient;

  const session = await provider.createSession(makeConfig('ctx-1'));
  const result = await session.execute('primary prompt');

  assert.equal(result.status, 'complete');
  assert.equal(promptCalls.length, 2);
  assert.equal(promptCalls[0]?.text, 'primary prompt');
  assert.equal(promptCalls[1]?.text, 'primary prompt');

  await session.destroy();
});

test('NonDestructiveOpenCodeProvider fails immediately when session probe confirms session is gone', async () => {
  const provider = new NonDestructiveOpenCodeProvider({ baseUrl: 'http://127.0.0.1:4098' });

  const fakeClient = {
    session: {
      async create(): Promise<{ data: { id: string } }> {
        return { data: { id: 'session-gone' } };
      },
      async get(): Promise<{ data: null }> {
        return { data: null };
      },
      async list(): Promise<{ data: Array<{ id: string; title: string; time: { updated: number } }> }> {
        return { data: [] };
      },
      async delete(): Promise<void> {},
      async abort(): Promise<void> {},
      async prompt(): Promise<{ data?: { info?: { error?: { name: string; data?: unknown } } } }> {
        const rootCause = new Error('connect ECONNRESET');
        throw new TypeError('fetch failed', { cause: rootCause });
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

  (provider as unknown as { client: unknown }).client = fakeClient;

  const session = await provider.createSession(makeConfig('ctx-2'));
  const result = await session.execute('prompt');
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /OpenCode session no longer exists/);

  await session.destroy();
});
