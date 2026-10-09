import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkerTaskAssignment } from '@ai-agent-board/shared/types.js';

const execFile = promisify(execFileCallback);

export interface RepositoryWorkspaceSettings {
  readonly workspacePath: string;
  readonly repositoryMappings?: Readonly<Record<string, string>>;
  readonly cloneRoot?: string;
}

export interface RepositoryResolverDependencies {
  readonly isDirectory?: (directory: string) => Promise<boolean>;
  readonly mkdir?: (directory: string) => Promise<void>;
  readonly runGit?: (...args: string[]) => Promise<void>;
}

function normalizePath(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
}

/** Turn HTTPS, SSH, and scp-style Git remotes into a portable repository key. */
export function canonicalRepoUrl(raw: string): string {
  const value = raw.trim();
  const scp = !value.includes('://') ? value.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/) : undefined;
  if (scp) {
    const host = scp[1]?.toLowerCase();
    const pathname = scp[2] ? normalizePath(scp[2]) : '';
    if (host && pathname) return `${host}/${pathname}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('repository identity must be an HTTP(S), SSH, Git, or scp-style Git URL');
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) {
    throw new Error('repository identity must be an HTTP(S), SSH, Git, or scp-style Git URL');
  }
  const pathname = normalizePath(url.pathname);
  if (!url.hostname || !pathname) {
    throw new Error('repository identity must include a host and repository path');
  }
  return `${url.hostname.toLowerCase()}/${pathname}`;
}

function mappingFor(
  repoKey: string,
  mappings: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!mappings) return undefined;
  for (const [candidate, directory] of Object.entries(mappings)) {
    try {
      if (canonicalRepoUrl(candidate) === repoKey) return directory;
    } catch {
      // Invalid local configuration entries cannot match a portable identity.
    }
  }
  return undefined;
}

/**
 * Resolves a portable repository identity to this worker's checkout. Legacy
 * assignments deliberately retain the configured workspace fallback.
 */
export async function resolveRepositoryWorkspace(
  task: WorkerTaskAssignment,
  settings: RepositoryWorkspaceSettings,
  dependencies: RepositoryResolverDependencies = {},
): Promise<string> {
  if (!task.repoUrl) return settings.workspacePath;

  const isDirectory = dependencies.isDirectory ?? (async (directory: string) => {
    const stats = await fs.stat(directory).catch(() => undefined);
    return stats?.isDirectory() === true;
  });
  const mkdir = dependencies.mkdir ?? (async (directory: string) => { await fs.mkdir(directory, { recursive: true }); });
  const runGit = dependencies.runGit ?? (async (...args: string[]) => { await execFile('git', args); });
  const repoKey = canonicalRepoUrl(task.repoUrl);
  const mapped = mappingFor(repoKey, settings.repositoryMappings);

  if (mapped) {
    if (!await isDirectory(mapped)) {
      throw new Error(`configured checkout for ${repoKey} is unavailable`);
    }
    await runGit('-C', mapped, 'fetch', '--prune', 'origin');
    return mapped;
  }

  if (!settings.cloneRoot) {
    throw new Error(`no local checkout is configured for ${repoKey}; set repositoryMappings or cloneRoot`);
  }
  const destination = path.join(settings.cloneRoot, ...repoKey.split('/'));
  if (await isDirectory(destination)) {
    await runGit('-C', destination, 'fetch', '--prune', 'origin');
    return destination;
  }

  await mkdir(path.dirname(destination));
  await runGit('clone', '--', task.repoUrl, destination);
  return destination;
}
