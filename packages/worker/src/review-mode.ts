import type { ReviewVerdict, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';

// A task started from the Review column has already been implemented, so the
// agent acts as a reviewer: it validates the existing work and reports a
// verdict instead of re-running the implementation.
export const REVIEW_VERDICT_MARKER = 'REVIEW_VERDICT:';

// OpenCode tools that modify files; wired into the opencode-server runner
// (local-runner.ts) so a reviewer cannot silently change the implementation
// it is assessing there. The agent-sdk-core runner (sdk-runner.ts) has no
// equivalent per-request tool allow/deny list in its AgentSession interface,
// so review runs through that path rely solely on the system prompt's
// instruction not to modify files — it is not enforced at the tool level.
export const REVIEW_DISABLED_TOOLS: Readonly<Record<string, boolean>> = { edit: false, write: false, patch: false };

export const REVIEW_SYSTEM_PROMPT = [
  'You are acting as a code REVIEWER, not as the implementer.',
  'The task below has already been implemented and is waiting for review.',
  'Inspect the existing changes (the diff between the task branch and its base branch when they are given,',
  'otherwise the uncommitted and most recent changes), validate them against the task requirements,',
  'and run the relevant tests or checks where appropriate.',
  'Look for regressions, missing requirements, and quality issues.',
  'Do NOT modify implementation files and do NOT re-implement the task — report findings only.',
  `End your response with a final line that is exactly ${REVIEW_VERDICT_MARKER} pass (plain text, with no`,
  `surrounding backticks, quotes, or markdown emphasis) when the work meets the requirements, or exactly`,
  `${REVIEW_VERDICT_MARKER} changes_requested when changes are required.`,
  'Before that line, list your findings; for changes_requested, make each required change specific and actionable.',
].join(' ');

export function isReviewRun(task: WorkerTaskAssignment): boolean {
  return task.mode === 'review';
}

// Task text (title/description) can come from a Jira import or any other
// untrusted source and is interpolated verbatim into the review prompt. If it
// contains something that looks like our own verdict marker, the model could
// echo it back (e.g. while reciting the task) and have it mistaken for a real
// verdict line by extractReviewVerdict. Break the literal "REVIEW_VERDICT:"
// token (case-insensitively) so task-supplied text can never produce a
// spurious match, while keeping the text readable.
const REVIEW_VERDICT_INJECTION_RE = /REVIEW_VERDICT\s*:/gi;
function neutralizeVerdictMarker(text: string): string {
  return text.replace(REVIEW_VERDICT_INJECTION_RE, 'REVIEW_VERDICT (quoted from task text, not a real verdict)');
}

export function buildReviewPrompt(task: WorkerTaskAssignment): string {
  const labels = task.labels.length > 0 ? task.labels.join(', ') : '(none)';
  const branch = task.branchName
    ? `Review the changes on branch \`${task.branchName}\` compared with \`${task.baseBranch || 'main'}\`.`
    : 'No task branch is recorded; review the uncommitted and most recent changes in the repository.';
  return [
    'Review the implementation of this task.',
    '',
    `Task title: ${neutralizeVerdictMarker(task.title)}`,
    '',
    `Task description: ${neutralizeVerdictMarker(task.description)}`,
    '',
    `Labels: ${labels}`,
    '',
    branch,
  ].join('\n');
}

export type ParsedReview = { readonly verdict: ReviewVerdict; readonly findings: string };

// Tolerant of the model wrapping the verdict word in backticks, asterisks,
// underscores, or quotes (e.g. `pass`, **pass**, "pass") and of trailing
// punctuation after it (e.g. pass., pass!), and accepts "changes requested"
// (space) as well as the requested "changes_requested" (underscore). Anchored
// to the start of a line so a verdict can't be produced by wording elsewhere
// in the text; when the marker line legitimately appears more than once, the
// LAST one wins (mirrors "final line" guidance in the system prompt).
const REVIEW_VERDICT_LINE_RE = /^\W*REVIEW_VERDICT:\s*[`*_"']*\s*(pass|changes[_ ]requested)\b.*$/gim;

/** Parses the last verdict line; findings are the text before it. */
export function extractReviewVerdict(text: string): ParsedReview | undefined {
  REVIEW_VERDICT_LINE_RE.lastIndex = 0;
  let last: RegExpExecArray | undefined;
  for (let match = REVIEW_VERDICT_LINE_RE.exec(text); match; match = REVIEW_VERDICT_LINE_RE.exec(text)) {
    last = match;
  }
  if (!last) return undefined;
  const verdict: ReviewVerdict = last[1].toLowerCase().replace(' ', '_') === 'pass' ? 'pass' : 'changes_requested';
  return { verdict, findings: text.slice(0, last.index).trim() };
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
  // Guard against an empty workspacePath: String.replaceAll('', x) inserts x
  // between every character of the findings text instead of doing nothing.
  const findings = workspacePath ? parsed.findings.replaceAll(workspacePath, '[local workspace]') : parsed.findings;
  return {
    status: 'complete',
    reviewVerdict: parsed.verdict,
    summary: findings || `Review verdict: ${parsed.verdict}`,
  };
}
