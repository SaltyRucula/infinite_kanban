import type { ReviewVerdict, WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';
import { extractInputRequest } from './input-request.js';

// A task started from the Review column has already been implemented, so the
// agent acts as a reviewer: it validates the existing work and reports a
// verdict instead of re-running the implementation.
export const REVIEW_VERDICT_MARKER = 'REVIEW_VERDICT:';

// OpenCode tools that modify files; wired into the opencode-server runner
// (local-runner.ts) so a reviewer's *individual edit/write/patch tool calls*
// are blocked there. This is NOT a full read-only guarantee on that path
// either: local-runner.ts's HEADLESS_PERMISSION_ENV sets `bash: 'allow'` and
// never disables the bash tool, so a reviewer can still modify files via
// shell there despite edit/write/patch being disabled. The agent-sdk-core
// runner (sdk-runner.ts) has no equivalent per-request tool allow/deny list
// in its AgentSession interface at all, so review runs through that path
// rely solely on the system prompt's instruction not to modify files — no
// enforcement whatsoever. In short: neither runner can guarantee a reviewer
// can't modify the repository; both rely at least partly on the model
// following instructions.
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
export function neutralizeVerdictMarker(text: string): string {
  return text.replace(REVIEW_VERDICT_INJECTION_RE, 'REVIEW_VERDICT (quoted from task text, not a real verdict)');
}

export function buildReviewPrompt(task: WorkerTaskAssignment): string {
  // Labels are as untrusted as title/description (e.g. Jira-imported) and go
  // through the same injection vector: normalizeTaskLabels only lowercases
  // and length-caps them (MAX_LABEL_LENGTH is comfortably above
  // "review_verdict: pass"'s 20 characters), and extractReviewVerdict is
  // case-insensitive, so an unneutralized label could produce the same
  // spurious match as an unneutralized title/description.
  const labels = task.labels.length > 0 ? task.labels.map(neutralizeVerdictMarker).join(', ') : '(none)';
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
// underscores, or quotes (e.g. `pass`, **pass**, "pass", _pass_) and of
// trailing punctuation after it (e.g. pass., pass!), and accepts "changes
// requested" (space) as well as the requested "changes_requested"
// (underscore). The leading wrapper class is an explicit whitelist (not
// `\W*`, which also matched blockquote `>` / heading `#` prefixes and made
// the marker too easy to trigger from quoted/incidental text) and includes
// `_` so italic-wrapped verdicts match — `_` is a word character, so a
// `\W*` prefix silently failed to consume it. For the same reason, the verdict
// word is followed by a lookahead (not `\b`): a trailing closing `_` (e.g.
// `_REVIEW_VERDICT: pass_`) is a word character too, so `pass\b` never
// matched there — while still rejecting a run-on like "passing" the way `\b`
// did. The colon may have leading whitespace (`REVIEW_VERDICT : pass`),
// mirroring what neutralizeVerdictMarker treats as the marker on the
// injection side.
const REVIEW_VERDICT_LINE_RE = /^[\s`*_"']*REVIEW_VERDICT\s*:\s*[`*_"']*\s*(pass|changes[_ ]requested)(?=[\s`*_"'.,!?;:)]|$).*$/gim;

/**
 * Parses the verdict line; findings are the text before it.
 *
 * The verdict marker can legitimately (or via an injection attempt) appear
 * more than once — e.g. the model quotes the expected format after already
 * reporting a real verdict. Naively taking the last match lets a trailing
 * "pass" example line hide a real "changes_requested" verdict, which is the
 * wrong direction to fail in. When matches disagree, prefer
 * changes_requested (fail-safe); only when every match agrees do we fall
 * back to the last one, mirroring the "final line" guidance in the system
 * prompt.
 */
export function extractReviewVerdict(text: string): ParsedReview | undefined {
  REVIEW_VERDICT_LINE_RE.lastIndex = 0;
  const matches: RegExpExecArray[] = [];
  for (let match = REVIEW_VERDICT_LINE_RE.exec(text); match; match = REVIEW_VERDICT_LINE_RE.exec(text)) {
    matches.push(match);
  }
  if (matches.length === 0) return undefined;
  const chosen = matches.find((match) => match[1].toLowerCase() !== 'pass') ?? matches[matches.length - 1];
  const verdict: ReviewVerdict = chosen[1].toLowerCase() === 'pass' ? 'pass' : 'changes_requested';
  return { verdict, findings: text.slice(0, chosen.index).trim() };
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
    // Belt-and-braces: INPUT_REQUEST_INSTRUCTIONS is gated off review runs
    // (see sdk-runner.ts / local-runner.ts), so a compliant reviewer should
    // never emit a NEEDS_INPUT: line. But if one slips through anyway (a
    // model recapping unrelated instructions, a stale system prompt, etc.),
    // surface it instead of the generic message so the question isn't
    // silently discarded.
    const needsInput = extractInputRequest(text);
    return {
      status: 'failed',
      summary: 'Review finished without a verdict',
      error: needsInput
        ? `review did not end with a ${REVIEW_VERDICT_MARKER} line; it asked instead: ${needsInput}`
        : `review did not end with a ${REVIEW_VERDICT_MARKER} line; the result cannot be treated as a pass`,
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
