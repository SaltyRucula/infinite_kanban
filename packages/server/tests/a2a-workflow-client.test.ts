import assert from 'node:assert/strict';
import test from 'node:test';
import { createA2AMessageSendParams } from '../src/services/a2a-workflow-client.js';
import type { WorkflowTicket } from '../src/services/workflow-policy.js';

function ticket(overrides: Partial<WorkflowTicket> = {}): WorkflowTicket {
  return {
    id: 'ticket-1',
    projectId: 'project-1',
    phase: 'rework_requested',
    reviewRound: 1,
    reviewFeedback: 'Add coverage for cancellation.',
    runs: [],
    ...overrides,
  };
}

test('creates an A2A implementation message with ticket context and review feedback', () => {
  const params = createA2AMessageSendParams(ticket(), {
    type: 'dispatch',
    role: 'implementation',
    agentId: 'implementer-1',
    reviewRound: 1,
    reviewFeedback: 'Add coverage for cancellation.',
  }, 'message-1');

  assert.deepEqual(params, {
    message: {
      role: 'ROLE_USER',
      messageId: 'message-1',
      parts: [{
        kind: 'text',
        text: 'Continue implementation for board ticket ticket-1.\n\nReview feedback:\nAdd coverage for cancellation.',
      }],
    },
    metadata: {
      'infinite_kanban.ticket_id': 'ticket-1',
      'infinite_kanban.project_id': 'project-1',
      'infinite_kanban.workflow_role': 'implementation',
      'infinite_kanban.review_round': 1,
    },
  });
});
