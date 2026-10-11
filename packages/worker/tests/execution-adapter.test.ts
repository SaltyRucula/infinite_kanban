import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { admitExecution, executeAssignment } from '../src/execution-adapter.js';
for (const role of ['review', 'implementation'] as const) {
  for (const mutation of ['tracked file', 'new HEAD'] as const) {
    test(`${role} refuses evidence when configured check changes ${mutation}, before running another check`, async () => {
      const root = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'execution-integrity-'));
      const repo = path.join(root, 'repo');
      const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe' }).toString().trim();
      git('init', repo);
      git('-C', repo, 'config', 'user.email', 'test@example.com');
      git('-C', repo, 'config', 'user.name', 'test');
      await writeFile(path.join(repo, 'file.txt'), 'original');
      git('-C', repo, 'add', '.');
      git('-C', repo, 'commit', '-m', 'initial');
      const commit = git('-C', repo, 'rev-parse', 'HEAD');
      const script =
        mutation === 'tracked file'
          ? "require('fs').writeFileSync('file.txt','changed')"
          : "require('child_process').execFileSync('git',['-c','user.name=Check','-c','user.email=check@localhost','commit','--allow-empty','-m','check moved HEAD'])";
      const config = {
        harness: 'codex' as const,
        roles: [role],
        projects: ['p'],
        repositories: { 'github.com/o/r': repo },
        stateDirectory: root,
        capabilities: [],
        checks: [
          { name: 'mutating', command: process.execPath, args: ['-e', script] },
          {
            name: 'must-not-run',
            command: process.execPath,
            args: ['-e', "require('fs').writeFileSync('second-check-ran','yes')"],
          },
        ],
      };
      const input = {
        ...assignment,
        role,
        baseRevision: commit,
        ...(role === 'review' ? { targetRevision: commit } : { targetRevision: undefined }),
        constraints: { deadline: Date.now() + 60000, ...(role === 'review' ? { readOnly: true } : {}) },
      };
      if (role === 'implementation') delete input.targetRevision;
      await assert.rejects(
        executeAssignment(input, config, async () =>
          JSON.stringify(
            role === 'review'
              ? { summary: 'Inspected', verdict: 'approved', findings: [] }
              : { summary: 'Implemented' },
          ),
        ),
        /execution subject changed/,
      );
      await assert.rejects(readFile(path.join(root, 'workspaces', 'a', 'second-check-ran')), {
        code: 'ENOENT',
      });
    });
  }
}

test('aborted noncooperative harness cannot publish evidence or a commit after returning', async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'execution-aborted-'));
  const repo = path.join(root, 'repo');
  const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe' }).toString().trim();
  git('init', repo);
  git('-C', repo, 'config', 'user.email', 'test@example.com');
  git('-C', repo, 'config', 'user.name', 'test');
  await writeFile(path.join(repo, 'file.txt'), 'original');
  git('-C', repo, 'add', '.');
  git('-C', repo, 'commit', '-m', 'initial');
  const commit = git('-C', repo, 'rev-parse', 'HEAD');
  const controller = new AbortController();
  let release!: (value: string) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const execution = executeAssignment(
    { ...assignment, baseRevision: commit, targetRevision: commit },
    {
      harness: 'codex',
      roles: ['review'],
      projects: ['p'],
      repositories: { 'github.com/o/r': repo },
      stateDirectory: root,
      capabilities: [],
      checks: [],
    },
    async () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    controller.signal,
  );
  await ready;
  controller.abort();
  release(JSON.stringify({ summary: 'Late review', verdict: 'approved', findings: [] }));
  await assert.rejects(execution, /abort/i);
  await assert.rejects(readFile(path.join(root, 'artifacts')), { code: 'ENOENT' });
});

const revision = 'a'.repeat(40);
const assignment: any = {
  schemaVersion: 1,
  taskId: 't',
  projectId: 'p',
  workflowRunId: 'r',
  assignmentId: 'a',
  attempt: 1,
  role: 'review',
  endpointId: 'e',
  repository: 'https://github.com/o/r',
  baseRevision: revision,
  targetRevision: revision,
  requirements: 'Review',
  requiredCapabilities: [],
  constraints: { deadline: Date.now() + 60000, readOnly: true },
};
test('refuses unsupported restrictions, consent and repository before starting harness', () => {
  const config: any = {
    harness: 'opencode',
    roles: ['implementation', 'review'],
    projects: ['p'],
    repositories: { 'github.com/o/r': '/local' },
    stateDirectory: '/local',
    capabilities: [],
    checks: [],
  };
  assert.throws(
    () => admitExecution({ ...assignment, constraints: { ...assignment.constraints, maxCost: 1 } }, config),
    /unexpected field/,
  );
  assert.throws(() => admitExecution(assignment, { ...config, roles: ['implementation'] }), /role/);
  assert.throws(() => admitExecution({ ...assignment, projectId: 'other' }, config), /consent/);
});
test('review resolves exact immutable commit in separate workspace and returns structured findings, never prose markers', async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'execution-adapter-'));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
  await writeFile(path.join(repo, 'file.txt'), 'original');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-m', 'initial']);
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
  await writeFile(path.join(repo, 'file.txt'), 'mutable checkout');
  let workspace = '';
  const result = await executeAssignment(
    { ...assignment, baseRevision: commit, targetRevision: commit },
    {
      harness: 'codex',
      roles: ['review'],
      projects: ['p'],
      repositories: { 'github.com/o/r': repo },
      stateDirectory: root,
      capabilities: [],
      checks: [],
    },
    async (input) => {
      workspace = input.directory;
      assert.equal(await readFile(path.join(workspace, 'file.txt'), 'utf8'), 'original');
      return JSON.stringify({ summary: 'Checked snapshot', verdict: 'approved', findings: [] });
    },
  );
  assert.notEqual(workspace, repo);
  assert.equal(result.revision, commit);
  assert.equal(result.verdict, 'approved');
  assert.equal(result.evidence[0].outcome, 'passed');
  assert.equal(await readFile(path.join(repo, 'file.txt'), 'utf8'), 'mutable checkout');
});
