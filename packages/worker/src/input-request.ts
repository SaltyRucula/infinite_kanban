import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';

// Headless runs have no interactive user, so an agent that is blocked on a
// missing requirement signals it with this marker instead of finishing. The
// worker reports it as `awaiting_input`, which moves the task to Pending
// rather than Review (Review means the implementation is ready to assess).
export const INPUT_REQUEST_MARKER = 'NEEDS_INPUT:';

export const INPUT_REQUEST_INSTRUCTIONS = [
  'If you are blocked by a genuinely unknown requirement and cannot safely proceed,',
  'do NOT guess and do NOT keep working. Instead, stop and end your response with a final',
  `line that starts with \`${INPUT_REQUEST_MARKER}\` followed by a clear, specific question`,
  'describing exactly what you need to know to continue. Only use that marker when you are',
  'blocked on human input — never when the work is finished. A human will answer and you',
  'will then continue from where you stopped.',
].join(' ');

/**
 * Escape a literal string for embedding in a RegExp source.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches the marker at the start of a (trimmed) line, tolerating leading
// markdown decoration the model commonly wraps it in (bold `**`, inline
// code backticks, a list marker `-`/`*`, or a blockquote `>` — all of which
// are non-word characters, hence `\W*`) as well as a matching closing
// decoration run immediately after the colon (e.g. `` `NEEDS_INPUT:` `` or
// `**NEEDS_INPUT:**`). The rest of the line is captured as the question;
// stripTrailingDecoration then removes any trailing decoration characters
// (e.g. a closing backtick that wraps the whole line) without touching real
// punctuation like a trailing "?".
const MARKER_LINE_PATTERN = new RegExp(`^\\W*${escapeRegExp(INPUT_REQUEST_MARKER)}\\s*[\`*_"']*\\s*(.*)$`);

function stripTrailingDecoration(text: string): string {
  return text.replace(/[`*_"']+\s*$/, '').trim();
}

function matchMarkerLine(line: string): string | undefined {
  const match = MARKER_LINE_PATTERN.exec(line.trim());
  if (!match) return undefined;
  const question = stripTrailingDecoration(match[1] ?? '');
  return question || undefined;
}

/**
 * Returns the question after the marker if — and only if — the marker
 * anchors the START of the FINAL non-empty line of the given text (allowing
 * common markdown decoration around it), or the second-to-last non-empty
 * line when the model appended a short trailing sign-off line after asking
 * (e.g. "Thanks for clarifying!") — exactly ONE such trailing line is
 * tolerated, without scanning back any further. The marker text is also
 * present verbatim in `INPUT_REQUEST_INSTRUCTIONS` (the system prompt every
 * agent is handed), so a model that recaps its own instructions mid-run
 * would otherwise false-positive park already-finished work — and because
 * `lastIndexOf` used to take *everything after* that occurrence as the
 * "question", the resulting text could be many KB, exceeding
 * MAX_DESCRIPTION_LENGTH and 400ing the completion POST. Anchoring to the
 * end of the text (rather than scanning the whole buffer) keeps that
 * protection while still tolerating a realistic sign-off line.
 */
export function extractInputRequest(text: string): string | undefined {
  const lines = text.split('\n');
  let index = lines.length - 1;
  while (index >= 0 && lines[index].trim() === '') index -= 1;
  if (index < 0) return undefined;

  const direct = matchMarkerLine(lines[index]);
  if (direct) return direct;

  let signOffIndex = index - 1;
  while (signOffIndex >= 0 && lines[signOffIndex].trim() === '') signOffIndex -= 1;
  if (signOffIndex < 0) return undefined;
  return matchMarkerLine(lines[signOffIndex]);
}

/** Answer prompt for a session that still holds the conversation history. */
export function buildResumeAnswerPrompt(resume: NonNullable<WorkerTaskAssignment['resume']>): string {
  return `Answer to your question: ${resume.answer}\n\nContinue the task.`;
}

/** Context carried into a fresh session when the original one is gone. */
export function buildResumeContext(resume: NonNullable<WorkerTaskAssignment['resume']>): string {
  return [
    'You previously paused this task to ask a question. Continue the task using the answer below.',
    '',
    `Your question: ${resume.question}`,
    '',
    `Answer: ${resume.answer}`,
  ].join('\n');
}
