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

/**
 * The port is part of the identity when it is not the protocol's default: two
 * self-hosted Git servers can share a host and differ only by port, and
 * dropping it would silently merge them into one repository.
 */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
  'ssh:': '22',
  'git:': '9418',
};

function authorityOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  const isDefaultPort = !url.port || url.port === DEFAULT_PORTS[url.protocol];
  return isDefaultPort ? host : `${host}:${url.port}`;
}

/** Turn HTTPS, SSH, and scp-style Git remotes into a portable repository key. */
export function canonicalRepoUrl(raw: string): string {
  const value = raw.trim();
  // `host:8443/owner/repo` is a canonical key with a port, not scp-style: the
  // scp form never starts its path with a port number followed by a slash.
  const looksLikePort = /^(?:[^@/:]+@)?[^/:]+:\d+\//.test(value);
  const scp = !value.includes('://') && !looksLikePort
    ? value.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/)
    : undefined;
  if (scp) {
    const host = scp[1]?.toLowerCase();
    const pathname = scp[2] ? normalizePath(scp[2]) : '';
    if (host && pathname) return `${host}/${pathname}`;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The key this function returns has no scheme, and it is the form users
    // see in error messages ("no local checkout is configured for
    // github.com/owner/repo"). Accept it back, so pasting that identity into
    // `repositoryMappings` matches instead of silently never matching.
    const asKey = canonicalKeyCandidate(value);
    if (asKey) return asKey;
    throw new Error('repository identity must be an HTTP(S), SSH, Git, or scp-style Git URL');
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) {
    // `host:8443/owner/repo` parses as a URL whose "scheme" is the hostname,
    // so a canonical key with a port arrives here rather than in the catch
    // above. Try it as a key before rejecting the value.
    const asKey = canonicalKeyCandidate(value);
    if (asKey) return asKey;
    throw new Error('repository identity must be an HTTP(S), SSH, Git, or scp-style Git URL');
  }
  const pathname = normalizePath(url.pathname);
  if (!url.hostname || !pathname) {
    throw new Error('repository identity must include a host and repository path');
  }
  return `${authorityOf(url)}/${pathname}`;
}

/**
 * Re-parses an already-canonical `host[:port]/path` key.
 *
 * Returns undefined for anything that is not host-shaped, so genuine garbage
 * still raises the identity error rather than becoming a key that can never
 * match a real remote.
 */
function canonicalKeyCandidate(value: string): string | undefined {
  // The host accepts only hostname characters and must carry a dot or an
  // explicit port. That is what stops `file:///srv/repos/thing.git` and other
  // local paths from being accepted as a repository identity: a scheme's colon
  // is never followed by a port number.
  if (!/^[a-z0-9][a-z0-9.-]*(?:\.[a-z0-9-]+|:\d+)\/[^\s]+$/i.test(value)) return undefined;
  try {
    const url = new URL(`https://${value}`);
    const pathname = normalizePath(url.pathname);
    if (!url.hostname || !pathname) return undefined;
    return `${authorityOf(url)}/${pathname}`;
  } catch {
    return undefined;
  }
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
