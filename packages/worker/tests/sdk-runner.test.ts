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
    { id: 'e2', contextId: 'task-1', type: 'output', content: '\nNEEDS_INPUT: Should the review cover tests too?', timestamp: Date.now() },
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

// SHOULD-FIX 2 regression (fixed in round 2): the previous version of this
// test passed identically whether or not sdk-runner reset outputText between
// bursts, because the marker text sat mid-sentence in the recap (never at a
// line start) — round 1's last-line anchoring alone already made that safe,
// independent of the reset. This version instead pins down what the reset
// actually buys: a genuine final answer's marker line must be detected even
// when a PRIOR burst's dangling text (with no trailing newline) would
// otherwise merge onto the same line and hide the marker from the
// start-of-line check. Reverting the outputText reset makes this test fail.
test('startAgentSdkTask detects a genuine question even when a prior burst without a trailing newline would otherwise merge into it', async () => {
  const provider = createFakeProvider([
    { id: 'e1', contextId: 'task-1', type: 'output', content: 'Investigated the repo and found the config.', timestamp: Date.now() },
    { id: 'e2', contextId: 'task-1', type: 'tool_call', content: 'ran a search', timestamp: Date.now() },
    { id: 'e3', contextId: 'task-1', type: 'output', content: 'NEEDS_INPUT: Which environment should this target?', timestamp: Date.now() },
  ]);

  const live = await startAgentSdkTask({
    task,
    workingDirectory: '/tmp/workspace',
    sendEvent: async () => {},
    providerFactory: () => provider,
  });
  const result = await live.done;

  assert.equal(result.status, 'awaiting_input');
  assert.equal(result.question, 'Which environment should this target?');
});

// A model that recaps its own system-prompt instructions mid-run (without
// genuinely being blocked) must not park already-finished work: the marker
// text sits mid-sentence, never at the start of a line, so extractInputRequest
// never matches it regardless of buffering.
test('startAgentSdkTask does not park when an earlier turn recaps the marker instructions but the run finishes normally', async () => {
  const provider = createFakeProvider([
    { id: 'e1', contextId: 'task-1', type: 'output', content: 'Understood — if truly blocked I will end with a line starting with NEEDS_INPUT: and a clear question.', timestamp: Date.now() },
    { id: 'e2', contextId: 'task-1', type: 'tool_call', content: 'ran the test suite', timestamp: Date.now() },
    { id: 'e3', contextId: 'task-1', type: 'output', content: 'All tests pass; feature implemented successfully.', timestamp: Date.now() },
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

// SHOULD-FIX (round 2): the provider resolves execute() on a synthetic
// 'complete' event, and sdk-runner then waits SESSION_ERROR_GRACE_MS before
// reading the buffer. The SSE stream can lag that resolution by a beat
// (documented in local-runner.ts's identical grace-period handling), so an
// unrelated trailing 'output' fragment can arrive AFTER the real final
// burst (containing the genuine question) already closed. That straggler
// must not erase the already-detected question.
test('startAgentSdkTask does not lose a genuine question to a late, unrelated SSE-lag output fragment after completion', async () => {
  const provider: AgentProvider = {
    name: 'opencode',
    displayName: 'Fake',
    model: 'fake-model',
    async start() {},
    async stop() {},
    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return {
        sessionId: 'ses_1',
        async execute() {
          config.onEvent({ id: 'e1', contextId: 'task-1', type: 'output', content: 'NEEDS_INPUT: Which environment should this target?', timestamp: Date.now() });
          // The synthetic "session finished" signal arrives via the SAME
          // onEvent stream, closing the burst that contained the question...
          config.onEvent({ id: 'e2', contextId: 'task-1', type: 'complete', content: 'Session idle.', timestamp: Date.now() });
          // ...and execute() resolves here, but a late, unrelated SSE
          // straggler (no marker) still arrives during the grace period.
          setTimeout(() => {
            config.onEvent({ id: 'e3', contextId: 'task-1', type: 'output', content: '', timestamp: Date.now() });
          }, 50);
          return { status: 'complete' };
        },
        async send() {},
        async abort() {},
        async destroy() {},
      };
    },
  };

  const live = await startAgentSdkTask({
    task,
    workingDirectory: '/tmp/workspace',
    sendEvent: async () => {},
    providerFactory: () => provider,
  });
  const result = await live.done;

  assert.equal(result.status, 'awaiting_input');
  assert.equal(result.question, 'Which environment should this target?');
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
