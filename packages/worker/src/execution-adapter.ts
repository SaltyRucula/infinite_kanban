import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  strictRecord,
  validateAssignment,
  validateResult,
  type ExecutionAssignment,
  type ExecutionResult,
} from '@ai-agent-board/shared/execution.js';
import { extractJsonDocument } from './harness-output.js';
import { isHarnessName, readOnlyDenial, resolveHarness } from './harness-registry.js';
import { canonicalRepoUrl } from './repository-resolution.js';
import type { ExecutionEndpointConfig, ExecutionHarness, HarnessProgress } from './execution-types.js';

export type { ExecutionEndpointConfig, ExecutionHarness, HarnessInput } from './execution-types.js';

const execFile = promisify(callback);

export function admitExecution(value: unknown, config: ExecutionEndpointConfig): ExecutionAssignment {
  const a = validateAssignment(value);
  if (!config.projects.includes(a.projectId)) throw new Error('endpoint refuses project consent');
  if (!config.roles.includes(a.role)) throw new Error('endpoint refuses role');
  if (!Object.keys(config.repositories).some((r) => canonicalRepoUrl(r) === canonicalRepoUrl(a.repository)))
    throw new Error('endpoint refuses repository');
  if (a.requiredCapabilities.some((c) => !config.capabilities.includes(c)))
    throw new Error('endpoint cannot enforce requested capability');
  if (Date.now() >= a.constraints.deadline) throw new Error('expired assignment');
  if (a.constraints.readOnly && a.role !== 'review')
    throw new Error('readOnly is only supported for snapshot review');
  // Refuse rather than review with a harness whose read-only cannot be enforced.
  if (a.role === 'review' && isHarnessName(config.harness)) {
    const denial = readOnlyDenial(config.harness);
    if (denial) throw new Error(denial);
  }
  return a;
}

/** Resolve the configured brain. Unknown names fail here, naming what is supported. */
export function harnessFor(config: ExecutionEndpointConfig): ExecutionHarness {
  return resolveHarness(config.harness)(config);
}

/** Endpoint-owned isolated checkout and evidence. Harness text is JSON, not a verdict marker. */
export async function executeAssignment(
  value: unknown,
  config: ExecutionEndpointConfig,
  harness: ExecutionHarness = harnessFor(config),
  signal?: AbortSignal,
  onProgress?: (progress: HarnessProgress) => void,
): Promise<ExecutionResult> {
  const a = admitExecution(value, config);
  const source = Object.entries(config.repositories).find(
    ([key]) => canonicalRepoUrl(key) === canonicalRepoUrl(a.repository),
  )![1];
  const workspace = path.join(config.stateDirectory, 'workspaces', a.assignmentId);
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  const git = async (...args: string[]) => {
    signal?.throwIfAborted();
    return (
      await execFile('git', args, {
        timeout: Math.max(1, a.constraints.deadline - Date.now()),
        maxBuffer: 8 * 1024 * 1024,
        signal,
      })
    ).stdout.trim();
  };
  await git('clone', '--no-hardlinks', '--', source, workspace);
  const target = a.role === 'review' ? a.targetRevision! : a.baseRevision;
  // Resolve EXACT commit. No HEAD/branch fallback and no shared mutable checkout.
  const resolved = await git('-C', workspace, 'rev-parse', '--verify', `${target}^{commit}`);
  if (resolved !== target) throw new Error('requested revision mismatch');
  await git('-C', workspace, 'checkout', '--detach', target);
  const prompt =
    a.role === 'implementation'
      ? `${a.requirements}\n\nImplement in this isolated checkout. Do not commit; the endpoint will publish a commit. Return a JSON object with only a nonempty summary field. No markdown.`
      : `${a.requirements}\n\nReview the exact immutable revision ${target}. Editing AND shell execution are disabled; inspect files using read tools. Return only JSON: {"summary":"...","verdict":"approved" or "changes_requested","findings":[{"severity":"error" or "warning" or "info","explanation":"actionable explanation","location":"optional relative file:line"}]}. Never use REVIEW_VERDICT prose.`;
  const output = await harness({
    directory: workspace,
    prompt,
    readOnly: a.role === 'review',
    deadline: a.constraints.deadline,
    signal,
    onProgress,
  });
  signal?.throwIfAborted();
  // Structured document only: narration around it is tolerated, unknown settlement
  // fields inside it are not. Keep the raw text when it cannot be parsed —
  // otherwise a harness incompatibility is invisible to whoever has to fix it.
  let document: unknown;
  try {
    document = extractJsonDocument(output);
  } catch (error) {
    const rawPath = path.join(config.stateDirectory, `${a.assignmentId}.output.txt`);
    await fs.writeFile(rawPath, output, { mode: 0o600 }).catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : 'unparsable harness output'} (raw output: ${rawPath})`);
  }
  const report = strictRecord(
    document,
    a.role === 'review' ? ['summary', 'verdict', 'findings'] : ['summary'],
  );
  if (typeof report.summary !== 'string' || !report.summary.trim())
    throw new Error('missing structured harness summary');
  if (
    a.role === 'review' &&
    ((await git('-C', workspace, 'status', '--porcelain')) ||
      (await git('-C', workspace, 'rev-parse', 'HEAD')) !== target)
  )
    throw new Error('review workspace changed');
  if (a.role === 'implementation') {
    await git('-C', workspace, 'add', '--all');
    await git(
      '-C',
      workspace,
      '-c',
      'user.name=Board execution endpoint',
      '-c',
      'user.email=execution@localhost',
      'commit',
      '--allow-empty',
      '-m',
      `Assignment ${a.assignmentId}`,
    );
  }
  const revision = await git('-C', workspace, 'rev-parse', 'HEAD');
  const verifySubject = async () => {
    if ((await git('-C', workspace, 'rev-parse', 'HEAD')) !== revision)
      throw new Error('execution subject changed: HEAD differs from evidence revision');
    try {
      await git('-C', workspace, 'diff', '--no-ext-diff', '--quiet', 'HEAD', '--');
    } catch {
      throw new Error('execution subject changed: tracked content differs from evidence revision');
    }
  };
  await verifySubject();
  const artifactDirectory = path.join(config.stateDirectory, 'artifacts');
  await fs.mkdir(artifactDirectory, { recursive: true });
  const artifact = async (content: string) => {
    const hash = createHash('sha256').update(content).digest('hex');
    await fs.writeFile(path.join(artifactDirectory, hash), content, { mode: 0o600 });
    return `urn:sha256:${hash}`;
  };
  const evidence: ExecutionResult['evidence'] = [
    {
      check: a.role === 'review' ? 'snapshot-review' : 'implementation',
      revision,
      outcome: 'passed',
      artifact: await artifact(output),
    },
  ];
  for (const check of config.checks) {
    let content: string,
      outcome: 'passed' | 'failed' = 'passed';
    try {
      const r = await execFile(check.command, check.args, {
        cwd: workspace,
        timeout: Math.max(1, a.constraints.deadline - Date.now()),
        maxBuffer: 4 * 1024 * 1024,
        signal,
      });
      content = r.stdout + r.stderr;
    } catch (e) {
      outcome = 'failed';
      const error = e as { stdout?: string; stderr?: string };
      content = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    }
    await verifySubject();
    evidence.push({ check: check.name, revision, outcome, artifact: await artifact(content) });
  }
  // Only publish a revision whose checks did not change their subject.
  if (a.role === 'implementation')
    await git('-C', source, 'fetch', workspace, `${revision}:refs/board-execution/${a.assignmentId}`);
  await verifySubject();
  return validateResult(
    {
      schemaVersion: 1,
      taskId: a.taskId,
      workflowRunId: a.workflowRunId,
      assignmentId: a.assignmentId,
      attempt: a.attempt,
      role: a.role,
      endpointId: a.endpointId,
      revision,
      summary: report.summary,
      evidence,
      ...(a.role === 'review' ? { verdict: report.verdict, findings: report.findings } : {}),
    },
    a,
  );
}
