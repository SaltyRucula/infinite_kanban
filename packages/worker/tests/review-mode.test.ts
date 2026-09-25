import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import { buildReviewPrompt, extractReviewVerdict, reviewResult } from '../src/review-mode.js';

const task: WorkerTaskAssignment = {
  id: 'task-1',
  title: 'Add retry to client',
  description: 'Retry failed requests three times',
  priority: 'medium',
  labels: [],
  branchName: 'feature/retry',
  baseBranch: 'develop',
  mode: 'review',
};

test('buildReviewPrompt asks for a review of the task branch against its base', () => {
  const prompt = buildReviewPrompt(task);
  assert.match(prompt, /Review the implementation of this task/);
  assert.match(prompt, /Task title: Add retry to client/);
  assert.match(prompt, /branch `feature\/retry` compared with `develop`/);
});

test('buildReviewPrompt falls back to recent changes without a branch', () => {
  assert.match(buildReviewPrompt({ ...task, branchName: undefined }), /No task branch is recorded/);
});

test('extractReviewVerdict parses the final verdict line and the findings before it', () => {
  assert.deepEqual(extractReviewVerdict('Looks good.\nTests pass.\nREVIEW_VERDICT: pass'), {
    verdict: 'pass',
    findings: 'Looks good.\nTests pass.',
  });
  assert.deepEqual(extractReviewVerdict('1. Retry count is 2, not 3.\nREVIEW_VERDICT: changes_requested'), {
    verdict: 'changes_requested',
    findings: '1. Retry count is 2, not 3.',
  });
});

test('extractReviewVerdict rejects missing or unknown verdicts', () => {
  assert.equal(extractReviewVerdict('All fine'), undefined);
  assert.equal(extractReviewVerdict('REVIEW_VERDICT: maybe'), undefined);
});

test('reviewResult never treats a missing verdict as a pass', () => {
  const result = reviewResult('I reviewed it and it seems fine.', '/tmp/workspace');
  assert.equal(result.status, 'failed');
  assert.equal(result.reviewVerdict, undefined);
  assert.match(result.error ?? '', /REVIEW_VERDICT/);
});

test('reviewResult strips the local workspace path from findings', () => {
  const result = reviewResult('Bug in /tmp/workspace/src/a.ts\nREVIEW_VERDICT: changes_requested', '/tmp/workspace');
  assert.equal(result.status, 'complete');
  assert.equal(result.reviewVerdict, 'changes_requested');
  assert.equal(result.summary, 'Bug in [local workspace]/src/a.ts');
});
