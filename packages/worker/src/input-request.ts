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

/** Returns the question after the last marker in the agent's final text, if any. */
export function extractInputRequest(text: string): string | undefined {
  const index = text.lastIndexOf(INPUT_REQUEST_MARKER);
  if (index < 0) return undefined;
  const question = text.slice(index + INPUT_REQUEST_MARKER.length).trim();
  return question || undefined;
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
