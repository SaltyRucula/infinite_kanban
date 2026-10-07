export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

export type WorkflowRole = 'implementation' | 'review';
export type WorkflowPhase = 'backlog' | 'implementing' | 'awaiting_review' | 'reviewing' | 'rework_requested' | 'done' | 'needs_human_decision';

export interface WorkflowRun {
  readonly id: string;
  readonly role: WorkflowRole;
  readonly agentId: string;
}

export interface WorkflowTicket {
  readonly id: string;
  readonly projectId: string;
  readonly phase: WorkflowPhase;
  readonly reviewRound: number;
  readonly runs: readonly WorkflowRun[];
  readonly reviewFeedback?: string;
}

export interface ReviewChangeRequest {
  readonly verdict: 'changes_requested';
  readonly feedback: string;
}

export interface ReviewApproval {
  readonly verdict: 'approved';
}

export type ReviewVerdict = ReviewChangeRequest | ReviewApproval;

export interface WorkflowAgent {
  readonly id: string;
  readonly enabled: boolean;
  readonly allowedProjectIds: readonly string[];
  readonly roles: readonly WorkflowRole[];
}

export type WorkflowAction =
  | {
    readonly type: 'dispatch';
    readonly role: WorkflowRole;
    readonly agentId: string;
    readonly reviewRound: number;
    readonly reviewFeedback?: string;
  }
  | { readonly type: 'wait' }
  | { readonly type: 'needs_human_decision'; readonly reason: string };

function eligibleAgents(
  ticket: WorkflowTicket,
  agents: readonly WorkflowAgent[],
  role: WorkflowRole,
): readonly WorkflowAgent[] {
  return agents.filter((agent) => (
    agent.enabled
    && agent.roles.includes(role)
    && agent.allowedProjectIds.includes(ticket.projectId)
  ));
}

export function applyReviewVerdict(
  ticket: WorkflowTicket,
  verdict: ReviewVerdict,
): WorkflowTicket {
  if (verdict.verdict === 'approved') {
    return { ...ticket, phase: 'done' };
  }

  if (ticket.reviewRound >= DEFAULT_MAX_REVIEW_ROUNDS) {
    return {
      ...ticket,
      phase: 'needs_human_decision',
      reviewFeedback: verdict.feedback,
    };
  }

  return {
    ...ticket,
    phase: 'rework_requested',
    reviewRound: ticket.reviewRound + 1,
    reviewFeedback: verdict.feedback,
  };
}

export function decideNextWorkflowAction(
  ticket: WorkflowTicket,
  agents: readonly WorkflowAgent[],
): WorkflowAction {
  if (ticket.phase === 'backlog' || ticket.phase === 'rework_requested') {
    const agent = eligibleAgents(ticket, agents, 'implementation')[0];
    if (!agent) {
      return { type: 'needs_human_decision', reason: 'no eligible implementation agent' };
    }

    return {
      type: 'dispatch',
      role: 'implementation',
      agentId: agent.id,
      reviewRound: ticket.reviewRound,
      ...(ticket.reviewFeedback !== undefined ? { reviewFeedback: ticket.reviewFeedback } : {}),
    };
  }

  if (ticket.phase === 'awaiting_review') {
    const implementationRun = [...ticket.runs].reverse().find((run) => run.role === 'implementation');
    if (!implementationRun) {
      return { type: 'needs_human_decision', reason: 'no implementation run available for review' };
    }
    const reviewer = eligibleAgents(ticket, agents, 'review')
      .find((agent) => agent.id !== implementationRun.agentId);
    if (!reviewer) {
      return { type: 'needs_human_decision', reason: 'no distinct eligible review agent' };
    }

    return {
      type: 'dispatch',
      role: 'review',
      agentId: reviewer.id,
      reviewRound: ticket.reviewRound,
    };
  }

  return { type: 'wait' };
}
