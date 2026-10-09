import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORKER_TASK_ASSIGNMENT_KEYS, type WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import { assignmentFromMessage, assignmentToMessage, assignmentToParts } from '../src/assignment.ts';
import { boardAgentCard, normalizeA2AAgentCard, workerAgentCard } from '../src/cards.ts';

const assignment: WorkerTaskAssignment = {
  id: 'task-1',
  title: 'Add rate limiting',
  description: 'Rate limit the worker event endpoint.',
  priority: 'high',
  agentType: 'opencode',
  branchName: 'agent/rate-limit',
  baseBranch: 'main',
  useWorktree: true,
  timeoutMinutes: 45,
  labels: ['backend'],
  project: { goal: 'Keep the board responsive', context: 'Express server' },
  agentPreference: 'build',
};

test('an assignment round-trips through an A2A message', () => {
  const message = assignmentToMessage(assignment, { messageId: 'm-1', contextId: 'ctx-1' });
  const decoded = assignmentFromMessage(message);
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.deepEqual(decoded.assignment, assignment);
});

test('the message carries a text prompt for agents that only read text', () => {
  const parts = assignmentToParts(assignment);
  assert.equal(parts[0]?.content?.$case, 'text');
  const prompt = parts[0]?.content?.$case === 'text' ? parts[0].content.value : '';
  assert.match(prompt, /Add rate limiting/);
  assert.match(prompt, /Rate limit the worker event endpoint/);
  assert.match(prompt, /Project goal: Keep the board responsive/);
  assert.equal(parts[1]?.content?.$case, 'data');
});

test('review mode and clarification resume reach the agent as text', () => {
  const review = assignmentToParts({ ...assignment, mode: 'review' })[0];
  assert.match(review?.content?.$case === 'text' ? review.content.value : '', /Mode: review/);
  const resumed = assignmentToParts({
    ...assignment,
    resume: { sessionId: 's-1', question: 'Which database?', answer: 'PostgreSQL' },
  })[0];
  const text = resumed?.content?.$case === 'text' ? resumed.content.value : '';
  assert.match(text, /Which database\?/);
  assert.match(text, /PostgreSQL/);
});

test('board-private fields are rejected, not silently ignored', () => {
  const message = assignmentToMessage(assignment, { messageId: 'm-1' });
  const poisoned = {
    ...message,
    metadata: undefined,
    parts: [{
      content: { $case: 'data' as const, value: { ...assignment, repoPath: '/Users/victim/secrets' } },
      metadata: undefined,
      filename: '',
      mediaType: 'application/json',
    }],
  };
  const decoded = assignmentFromMessage(poisoned);
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.match(decoded.error, /repoPath/);
});

test('only allowlisted assignment fields are serialized', () => {
  const message = assignmentToMessage(
    { ...assignment, ...({ repoPath: '/Users/victim/secrets', worktreePath: '/tmp/wt' } as object) } as WorkerTaskAssignment,
    { messageId: 'm-1' },
  );
  const dataPart = message.parts.find((part) => part.content?.$case === 'data');
  const value = dataPart?.content?.$case === 'data' ? dataPart.content.value as Record<string, unknown> : {};
  for (const key of Object.keys(value)) {
    assert.ok(
      (WORKER_TASK_ASSIGNMENT_KEYS as readonly string[]).includes(key),
      `field ${key} escaped the allowlist`,
    );
  }
  assert.equal('repoPath' in value, false);
  assert.equal('worktreePath' in value, false);
});

test('a message with no assignment payload is an error, not an empty task', () => {
  const decoded = assignmentFromMessage({
    messageId: 'm-2',
    contextId: '',
    taskId: '',
    role: 1,
    parts: [{ content: { $case: 'text', value: 'do something' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  });
  assert.equal(decoded.ok, false);
});

test('the board card advertises both bindings, the extension, and its skills', () => {
  const card = boardAgentCard({ baseUrl: 'https://board.example.com/', version: '0.1.0', authRequired: true });
  assert.deepEqual(
    card.supportedInterfaces.map((item) => item.protocolBinding),
    ['JSONRPC', 'HTTP+JSON'],
  );
  for (const item of card.supportedInterfaces) {
    assert.equal(item.url, 'https://board.example.com/a2a/v1');
  }
  assert.deepEqual(card.skills.map((item) => item.id), ['code-task', 'code-review', 'task-group']);
  assert.equal(card.capabilities?.streaming, true);
  assert.equal(card.capabilities?.pushNotifications, true);
  assert.equal(card.capabilities?.extensions.length, 1);
  assert.ok(card.securitySchemes.bearer, 'bearer scheme missing when auth is required');
  assert.equal(card.securityRequirements.length, 1);
});

test('an open board declares no security schemes', () => {
  const card = boardAgentCard({ baseUrl: 'http://localhost:8080', version: '0.1.0', authRequired: false });
  assert.deepEqual(card.securitySchemes, {});
  assert.deepEqual(card.securityRequirements, []);
});

test('normalizes a supported JSON-RPC Agent Card for the trusted directory', () => {
  assert.deepEqual(normalizeA2AAgentCard({
    name: 'Implementation Agent',
    description: 'Works on board tickets.',
    version: '1.0.0',
    supportedInterfaces: [{
      url: 'https://agents.example.test/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0.3',
    }],
    skills: [{
      id: 'implementation',
      name: 'Implementation',
      tags: ['coding', 'typescript'],
    }],
  }), {
    name: 'Implementation Agent',
    description: 'Works on board tickets.',
    version: '1.0.0',
    endpoint: 'https://agents.example.test/a2a',
    protocolVersion: '1.0',
    skills: [{ id: 'implementation', name: 'Implementation', tags: ['coding', 'typescript'] }],
  });
});

test('a worker card exposes one skill per agent type and carries its consent', () => {
  const card = workerAgentCard({
    baseUrl: 'http://worker.local:8099',
    version: '0.1.0',
    name: 'laptop-1',
    agentTypes: ['opencode', 'codex'],
    authRequired: true,
    consent: { acceptedProjectIds: ['p1'], acceptedLabels: ['backend'] },
  });
  assert.deepEqual(card.skills.map((item) => item.id), ['run-opencode', 'run-codex']);
  assert.equal(card.capabilities?.pushNotifications, false);
  assert.ok(card.capabilities?.extensions[0]?.params, 'consent params missing');
});
