import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent as CoreEvent, AgentProvider, AgentSession, AgentSessionConfig } from '@codewithdan/agent-sdk-core';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import { startAgentSdkTask } from '../src/sdk-runner.js';

const task: WorkerTaskAssignment = {
  id: 'task-1',
  title: 'Review a PR',
  description: 'Independent review task',
  priority: 'low',
  labels: [],
  agentType: 'opencode',
};

function createFakeProvider(events: readonly CoreEvent[]): AgentProvider {
  return {
    name: 'opencode',
    displayName: 'Fake',
    model: 'fake-model',
    async start() {},
    async stop() {},
    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return {
        sessionId: 'ses_1',
        async execute() {
          for (const event of events) config.onEvent(event);
          return { status: 'complete' };
        },
        async send() {},
        async abort() {},
        async destroy() {},
      };
    },
  };
}

// Regression test: the vendored OpenCodeProvider can report `{status:
// 'complete'}` from execute() even when it also emitted an 'error' event
// through the same onEvent callback (its `info.error` check misses some
// internal failures). This must be caught and downgraded to 'failed'.
test('startAgentSdkTask reports failed when execute() resolves complete but an error event was emitted', async () => {
  const provider = createFakeProvider([
    { id: 'e1', contextId: 'task-1', type: 'error', content: 'Agent not found: "sisyphus"', timestamp: Date.now() },
  ]);
  const events: CoreEvent[] = [];

  const live = await startAgentSdkTask({
    task,
    workingDirectory: '/tmp/workspace',
    sendEvent: async (event) => { events.push(event as unknown as CoreEvent); },
    providerFactory: () => provider,
  });
  const result = await live.done;

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /Agent not found/);
});

test('startAgentSdkTask reports complete when execute() resolves complete with no error events', async () => {
  const provider = createFakeProvider([
    { id: 'e1', contextId: 'task-1', type: 'output', content: 'did the work', timestamp: Date.now() },
  ]);

  const live = await startAgentSdkTask({
    task,
    workingDirectory: '/tmp/workspace',
    sendEvent: async () => {},
    providerFactory: () => provider,
  });
  const result = await live.done;

  assert.equal(result.status, 'complete');
});

test('startAgentSdkTask reports awaiting_input when the agent output ends with a blocking question', async () => {
  const provider = createFakeProvider([
    { id: 'e1', contextId: 'task-1', type: 'output', content: 'Checked the repo. ', timestamp: Date.now() },
    { id: 'e2', contextId: 'task-1', type: 'output', content: 'NEEDS_INPUT: Should the review cover tests too?', timestamp: Date.now() },
  ]);

  const live = await startAgentSdkTask({
    task,
    workingDirectory: '/tmp/workspace',
    sendEvent: async () => {},
    providerFactory: () => provider,
  });
  const result = await live.done;

  assert.equal(result.status, 'awaiting_input');
  assert.equal(result.question, 'Should the review cover tests too?');
});

test('startAgentSdkTask carries a resumed question and answer into the prompt', async () => {
  const prompts: string[] = [];
  const provider = createFakeProvider([]);
  const createSession = provider.createSession.bind(provider);
  provider.createSession = async (config) => {
    const session = await createSession(config);
    return { ...session, sessionId: session.sessionId, execute: async (prompt: string) => { prompts.push(prompt); return { status: 'complete' }; } };
  };

  const live = await startAgentSdkTask({
    task: { ...task, resume: { sessionId: 'ses_old', question: 'Cover tests?', answer: 'Yes' } },
    workingDirectory: '/tmp/workspace',
    sendEvent: async () => {},
    providerFactory: () => provider,
  });
  await live.done;

  assert.match(prompts[0] ?? '', /Your question: Cover tests\?/);
  assert.match(prompts[0] ?? '', /Answer: Yes/);
});
