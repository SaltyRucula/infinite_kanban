import type { ReviewVerdict, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';

// A task started from the Review column has already been implemented, so the
// agent acts as a reviewer: it validates the existing work and reports a
// verdict instead of re-running the implementation.
export const REVIEW_VERDICT_MARKER = 'REVIEW_VERDICT:';

// OpenCode tools that modify files; disabled for review runs so a reviewer
// cannot silently change the implementation it is assessing.
export const REVIEW_DISABLED_TOOLS: Readonly<Record<string, boolean>> = { edit: false, write: false, patch: false };

export const REVIEW_SYSTEM_PROMPT = [
  'You are acting as a code REVIEWER, not as the implementer.',
  'The task below has already been implemented and is waiting for review.',
  'Inspect the existing changes (the diff between the task branch and its base branch when they are given,',
  'otherwise the uncommitted and most recent changes), validate them against the task requirements,',
  'and run the relevant tests or checks where appropriate.',
  'Look for regressions, missing requirements, and quality issues.',
  'Do NOT modify implementation files and do NOT re-implement the task — report findings only.',
  `End your response with a final line that is exactly \`${REVIEW_VERDICT_MARKER} pass\` when the work`,
  `meets the requirements, or \`${REVIEW_VERDICT_MARKER} changes_requested\` when changes are required.`,
  'Before that line, list your findings; for changes_requested, make each required change specific and actionable.',
].join(' ');

export function isReviewRun(task: WorkerTaskAssignment): boolean {
  return task.mode === 'review';
}

export function buildReviewPrompt(task: WorkerTaskAssignment): string {
  const labels = task.labels.length > 0 ? task.labels.join(', ') : '(none)';
  const branch = task.branchName
    ? `Review the changes on branch \`${task.branchName}\` compared with \`${task.baseBranch || 'main'}\`.`
    : 'No task branch is recorded; review the uncommitted and most recent changes in the repository.';
  return [
    'Review the implementation of this task.',
    '',
    `Task title: ${task.title}`,
    '',
    `Task description: ${task.description}`,
    '',
    `Labels: ${labels}`,
    '',
    branch,
  ].join('\n');
}

export type ParsedReview = { readonly verdict: ReviewVerdict; readonly findings: string };

/** Parses the last verdict line; findings are the text before it. */
export function extractReviewVerdict(text: string): ParsedReview | undefined {
  const index = text.lastIndexOf(REVIEW_VERDICT_MARKER);
  if (index < 0) return undefined;
  const value = text.slice(index + REVIEW_VERDICT_MARKER.length).trim().split(/\s/)[0]?.toLowerCase() ?? '';
  const verdict: ReviewVerdict | undefined = value === 'pass'
    ? 'pass'
    : value === 'changes_requested' ? 'changes_requested' : undefined;
  if (!verdict) return undefined;
  return { verdict, findings: text.slice(0, index).trim() };
}

export type ReviewRunResult = {
  readonly status: 'complete' | 'failed';
  readonly summary: string;
  readonly error?: string;
  readonly reviewVerdict?: ReviewVerdict;
};

/** Maps the reviewer's final text to a run result; a missing verdict is never a pass. */
export function reviewResult(text: string, workspacePath: string): ReviewRunResult {
  const parsed = extractReviewVerdict(text);
  if (!parsed) {
    return {
      status: 'failed',
      summary: 'Review finished without a verdict',
      error: `review did not end with a ${REVIEW_VERDICT_MARKER} line; the result cannot be treated as a pass`,
    };
  }
  const findings = parsed.findings.replaceAll(workspacePath, '[local workspace]');
  return {
    status: 'complete',
    reviewVerdict: parsed.verdict,
    summary: findings || `Review verdict: ${parsed.verdict}`,
  };
}
