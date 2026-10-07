import type { WorkflowAction, WorkflowTicket } from './workflow-policy.js';

export interface A2ATextPart {
  readonly kind: 'text';
  readonly text: string;
}

export interface A2AMessage {
  readonly role: 'ROLE_USER';
  readonly messageId: string;
  readonly parts: readonly A2ATextPart[];
}

export interface A2AMessageSendParams {
  readonly message: A2AMessage;
  readonly metadata: Readonly<Record<string, string | number>>;
}

type WorkflowDispatchAction = Extract<WorkflowAction, { readonly type: 'dispatch' }>;

function promptFor(ticket: WorkflowTicket, action: WorkflowDispatchAction): string {
  if (action.role === 'review') {
    return `Review board ticket ${ticket.id}.`;
  }
  if (action.reviewFeedback !== undefined) {
    return `Continue implementation for board ticket ${ticket.id}.\n\nReview feedback:\n${action.reviewFeedback}`;
  }
  return `Implement board ticket ${ticket.id}.`;
}

/**
 * Converts a board-owned workflow dispatch into A2A `message/send` parameters.
 * Transport, Agent Card lookup, and remote task lifecycle handling remain
 * outside this pure mapper.
 */
export function createA2AMessageSendParams(
  ticket: WorkflowTicket,
  action: WorkflowDispatchAction,
  messageId: string,
): A2AMessageSendParams {
  return {
    message: {
      role: 'ROLE_USER',
      messageId,
      parts: [{ kind: 'text', text: promptFor(ticket, action) }],
    },
    metadata: {
      'infinite_kanban.ticket_id': ticket.id,
      'infinite_kanban.project_id': ticket.projectId,
      'infinite_kanban.workflow_role': action.role,
      'infinite_kanban.review_round': action.reviewRound,
    },
  };
}
