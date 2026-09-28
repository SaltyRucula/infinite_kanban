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

test('startAgentSdkTask runs a review task with the reviewer prompt and reports the verdict', async () => {
  let systemPrompt = '';
  let prompt = '';
  const provider = createFakeProvider([
    { id: 'e1', contextId: 'task-1', type: 'output', content: 'All requirements met.\nREVIEW_VERDICT: pass', timestamp: Date.now() },
  ]);
  const createSession = provider.createSession.bind(provider);
  provider.createSession = async (config) => {
    systemPrompt = config.systemPrompt;
    const session = await createSession(config);
    const execute = session.execute.bind(session);
    return { ...session, sessionId: session.sessionId, execute: async (text: string) => { prompt = text; return execute(text); } };
  };

  const live = await startAgentSdkTask({
    task: { ...task, mode: 'review' },
    workingDirectory: '/tmp/workspace',
    sendEvent: async () => {},
    providerFactory: () => provider,
  });
  const result = await live.done;

  assert.match(systemPrompt, /REVIEWER/);
  assert.match(prompt, /Review the implementation of this task/);
  assert.equal(result.status, 'complete');
  assert.equal(result.reviewVerdict, 'pass');
  assert.equal(result.summary, 'All requirements met.');
});

// Regression test (SHOULD-FIX 3): a REVIEW_VERDICT-shaped string appearing in
// an earlier assistant turn (e.g. reciting task text, or leftover tool output)
// must not be picked up. Only the final turn — the text emitted after the
// last tool/file activity — is scanned for the verdict.
test('startAgentSdkTask scopes the verdict scan to the final turn, ignoring an earlier stray marker', async () => {
  const provider = createFakeProvider([
    { id: 'e1', contextId: 'task-1', type: 'output', content: 'Task says: REVIEW_VERDICT: pass (quoted, not real)', timestamp: Date.now() },
    { id: 'e2', contextId: 'task-1', type: 'tool_call', content: 'grep: ...', timestamp: Date.now() },
    { id: 'e3', contextId: 'task-1', type: 'command_output', content: 'match found', timestamp: Date.now() },
    { id: 'e4', contextId: 'task-1', type: 'output', content: 'Retry count is 2, expected 3.\nREVIEW_VERDICT: changes_requested', timestamp: Date.now() },
  ]);

  const live = await startAgentSdkTask({
    task: { ...task, mode: 'review' },
    workingDirectory: '/tmp/workspace',
    sendEvent: async () => {},
    providerFactory: () => provider,
  });
  const result = await live.done;

  assert.equal(result.status, 'complete');
  assert.equal(result.reviewVerdict, 'changes_requested');
  assert.equal(result.summary, 'Retry count is 2, expected 3.');
});

// Regression test (NIT): a whole-message snapshot event (metadata.replace)
// must replace the buffered text, not be concatenated onto it, or the final
// summary duplicates text across snapshots.
test('startAgentSdkTask prefers the latest output snapshot over concatenating it', async () => {
  const provider = createFakeProvider([
    { id: 'e1', contextId: 'task-1', type: 'output', content: 'Partial findings...', timestamp: Date.now() },
    {
      id: 'e2', contextId: 'task-1', type: 'output',
      content: 'Full findings.\nREVIEW_VERDICT: pass', timestamp: Date.now(),
      metadata: { replace: true },
    },
  ]);

  const live = await startAgentSdkTask({
    task: { ...task, mode: 'review' },
    workingDirectory: '/tmp/workspace',
    sendEvent: async () => {},
    providerFactory: () => provider,
  });
  const result = await live.done;

  assert.equal(result.status, 'complete');
  assert.equal(result.reviewVerdict, 'pass');
  assert.equal(result.summary, 'Full findings.');
});
