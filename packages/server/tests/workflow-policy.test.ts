import assert from 'node:assert/strict';
import test from 'node:test';
import { applyReviewVerdict, decideNextWorkflowAction, type WorkflowAgent, type WorkflowTicket } from '../src/services/workflow-policy.js';

function ticket(overrides: Partial<WorkflowTicket> = {}): WorkflowTicket {
  return {
    id: 'ticket-1',
    projectId: 'project-1',
    phase: 'backlog',
    reviewRound: 0,
    runs: [],
    ...overrides,
  };
}

function agent(overrides: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return {
    id: 'implementer-1',
    enabled: true,
    allowedProjectIds: ['project-1'],
    roles: ['implementation'],
    ...overrides,
  };
}

test('dispatches a backlog ticket to an eligible implementation agent', () => {
  const action = decideNextWorkflowAction(ticket(), [agent()]);

  assert.deepEqual(action, {
    type: 'dispatch',
    role: 'implementation',
    agentId: 'implementer-1',
    reviewRound: 0,
  });
});

test('dispatches a distinct eligible reviewer after implementation', () => {
  const action = decideNextWorkflowAction(ticket({
    phase: 'awaiting_review',
    runs: [{ id: 'implementation-1', role: 'implementation', agentId: 'implementer-1' }],
  }), [
    agent({ roles: ['implementation', 'review'] }),
    agent({ id: 'reviewer-1', roles: ['review'] }),
  ]);

  assert.deepEqual(action, {
    type: 'dispatch',
    role: 'review',
    agentId: 'reviewer-1',
    reviewRound: 0,
  });
});

test('records review feedback and requeues implementation after changes are requested', () => {
  const updated = applyReviewVerdict(ticket({ phase: 'reviewing' }), {
    verdict: 'changes_requested',
    feedback: 'Add coverage for the failed-request path.',
  });

  assert.deepEqual(updated, ticket({
    phase: 'rework_requested',
    reviewRound: 1,
    reviewFeedback: 'Add coverage for the failed-request path.',
  }));
});

test('dispatches implementation again after review changes are requested', () => {
  const action = decideNextWorkflowAction(ticket({
    phase: 'rework_requested',
    reviewRound: 1,
    reviewFeedback: 'Add coverage for the failed-request path.',
  }), [agent()]);

  assert.deepEqual(action, {
    type: 'dispatch',
    role: 'implementation',
    agentId: 'implementer-1',
    reviewRound: 1,
    reviewFeedback: 'Add coverage for the failed-request path.',
  });
});

test('closes the ticket after review approval', () => {
  const updated = applyReviewVerdict(ticket({ phase: 'reviewing', reviewRound: 1 }), {
    verdict: 'approved',
  });

  assert.deepEqual(updated, ticket({ phase: 'done', reviewRound: 1 }));
});

test('escalates after the configured review-round limit is exhausted', () => {
  const updated = applyReviewVerdict(ticket({ phase: 'reviewing', reviewRound: 3 }), {
    verdict: 'changes_requested',
    feedback: 'The remaining design decision needs a human owner.',
  });

  assert.deepEqual(updated, ticket({
    phase: 'needs_human_decision',
    reviewRound: 3,
    reviewFeedback: 'The remaining design decision needs a human owner.',
  }));
});
