import assert from 'node:assert/strict';
import test from 'node:test';
import { intakeWorkRequest } from '../src/a2a/intake.ts';
import type { Message, Part } from '@a2a-js/sdk';

function textPart(value: string): Part {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

function dataPart(value: unknown): Part {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' };
}

function message(parts: Part[], metadata?: Record<string, unknown>, messageId = 'msg-1'): Message {
  return {
    messageId,
    contextId: '',
    taskId: '',
    role: 1,
    parts,
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

test('a text-only peer can describe work: first line is the title, the rest is the description', () => {
  const result = intakeWorkRequest(message(
    [textPart('Add rate limiting\n\nThe worker event endpoint accepts unbounded traffic.')],
    { project: 'board' },
  ));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.title, 'Add rate limiting');
  assert.equal(result.request.description, 'The worker event endpoint accepts unbounded traffic.');
  assert.equal(result.request.project, 'board');
  assert.equal(result.request.autoStart, true);
  assert.equal(result.request.review, false);
  // The client-generated messageId is the natural idempotency key (spec §3.3.1).
  assert.equal(result.request.idempotencyKey, 'msg-1');
});

test('a structured data part refines the request', () => {
  const result = intakeWorkRequest(message([
    textPart('Implement the thing'),
    dataPart({
      project: 'board',
      title: 'Explicit title',
      agentType: 'opencode',
      priority: 'high',
      baseBranch: 'main',
      branchName: 'agent/explicit',
      timeoutMinutes: 45,
      labels: ['Backend', 'backend'],
      autoStart: false,
      mode: 'review',
    }),
  ]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.title, 'Explicit title');
  assert.equal(result.request.description, 'Implement the thing');
  assert.equal(result.request.agentType, 'opencode');
  assert.equal(result.request.priority, 'high');
  assert.equal(result.request.branchName, 'agent/explicit');
  assert.equal(result.request.timeoutMinutes, 45);
  assert.deepEqual(result.request.labels, ['backend']);
  assert.equal(result.request.autoStart, false);
  assert.equal(result.request.review, true);
});

test('metadata wins over a data part so an orchestrator can override a template', () => {
  const result = intakeWorkRequest(message(
    [textPart('Do the work'), dataPart({ project: 'from-data', priority: 'low' })],
    { project: 'from-metadata', idempotencyKey: 'stable-key' },
  ));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.project, 'from-metadata');
  assert.equal(result.request.priority, 'low');
  assert.equal(result.request.idempotencyKey, 'stable-key');
});

test('board-private fields are refused, not ignored', () => {
  for (const field of ['repoPath', 'worktreePath', 'assignedWorkerId', 'projectId', 'columnId', 'id']) {
    const result = intakeWorkRequest(message(
      [textPart('Do the work')],
      { project: 'board', [field]: 'anything' },
    ));
    assert.equal(result.ok, false, `${field} was accepted`);
    if (!result.ok) assert.match(result.error, new RegExp(field));
  }
});

test('unknown fields are refused so a typo cannot silently change behaviour', () => {
  const result = intakeWorkRequest(message([textPart('Work')], { project: 'board', autostart: false }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /autostart/);
});

test('extension-namespaced metadata keys are allowed through', () => {
  const result = intakeWorkRequest(message(
    [textPart('Work')],
    { project: 'board', 'https://example.com/extensions/geolocation/v1': { latitude: 1 } },
  ));
  assert.equal(result.ok, true);
});

test('validation mirrors the board limits', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /project is required/],
    [{ project: 'board', title: 'x'.repeat(300) }, /title must be at most/],
    [{ project: 'board', description: 'x'.repeat(20_001) }, /description must be at most/],
    [{ project: 'board', agent: 'not-an-agent' }, /supported agent type/],
    [{ project: 'board', priority: 'urgent' }, /invalid priority/],
    [{ project: 'board', timeoutMinutes: 0 }, /timeoutMinutes must be an integer/],
    [{ project: 'board', baseBranch: 'bad branch' }, /baseBranch is not a valid git ref/],
    [{ project: 'board', branchName: '../escape' }, /branchName is not a valid git ref/],
    [{ project: 'board', labels: 'backend' }, /labels must be an array/],
    [{ project: 'board', autoStart: 'yes' }, /autoStart must be a boolean/],
    [{ project: 'board', isolation: 'none' }, /worktree isolation/],
    [{ project: 'board', mode: 'audit' }, /mode must be/],
  ];
  for (const [metadata, expected] of cases) {
    const result = intakeWorkRequest(message([textPart('Add rate limiting')], metadata));
    assert.equal(result.ok, false, `accepted ${JSON.stringify(metadata)}`);
    if (!result.ok) assert.match(result.error, expected);
  }
});

test('a message with no text and no title is refused', () => {
  const result = intakeWorkRequest(message([dataPart({ project: 'board' })]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /title is required/);
});

test('provenance is sanitized onto the board allowlist', () => {
  const result = intakeWorkRequest(message([textPart('Work')], {
    project: 'board',
    provenance: {
      profile: 'default',
      platform: 'telegram',
      sessionId: 'session-1',
      messageId: 'message-7',
      requestedBy: 'jose',
      origin: { chat: 42 },
      secret: 'should not survive',
    },
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.request.provenance, {
    sourceProfile: 'default',
    sourcePlatform: 'telegram',
    sourceSession: 'session-1',
    sourceMessage: 'message-7',
    requestedBy: 'jose',
    origin: { chat: 42 },
  });
});
