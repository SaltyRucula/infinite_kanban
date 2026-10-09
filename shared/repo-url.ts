/**
 * Canonicalizing repository remotes so the board and an executor on a
 * different machine agree on what "the same repository" means.
 *
 * The same repository is written many ways — `git@github.com:owner/repo.git`,
 * `https://github.com/owner/repo`, `ssh://git@github.com/owner/repo.git`,
 * sometimes with a trailing slash, a token in the userinfo, or mixed case in
 * the host. If the board sends one spelling and a worker's config holds
 * another, the lookup misses and the work runs in the wrong place (or nowhere).
 * Every comparison therefore goes through `normalizeRepoUrl` first.
 */

/**
 * Canonical form: lowercase `host/path`, with no scheme, credentials, `.git`
 * or trailing slash.
 *
 * Lowercased in full because this value is a lookup key on both sides — a
 * worker's mapping and the board's project — and the hosts people use treat
 * repository paths case-insensitively. Matching must not depend on whether
 * someone typed `Owner/Repo` or `owner/repo`.
 */
export function normalizeRepoUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const scpLike = trimmed.match(/^([^@/\s]+)@([^:/\s]+):(.+)$/);
  const candidate = scpLike
    // `git@host:owner/repo.git` is not a URL; rewrite it into one before parsing.
    ? `ssh://${scpLike[2]}/${scpLike[3]}`
    // The canonical form this function returns has no scheme, and it must
    // round-trip: the board sends `github.com/owner/repo`, and a worker
    // normalizing that again has to get the same answer rather than "not a
    // repository". Anything with a host-looking first segment and a path is
    // given the default scheme before parsing.
    // The scheme test requires `://`: a bare `host:port/path` would otherwise
    // look like a scheme, because a hostname may contain dots too.
    : /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || !/^[^/\s]+[.:][^/\s]*\/[^\s]/.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }

  if (!/^(https?|ssh|git):$/.test(parsed.protocol)) return undefined;

  const host = parsed.hostname.toLowerCase();
  if (!host) return undefined;
  const port = parsed.port && parsed.port !== '22' && parsed.port !== '443' && parsed.port !== '80'
    ? `:${parsed.port}`
    : '';

  const path = parsed.pathname
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .replace(/^\/+/, '')
    .toLowerCase();
  if (!path) return undefined;

  return `${host}${port}/${path}`;
}

/** The last path segment of a repository URL, usable as a directory name. */
export function repoNameFromUrl(raw: string): string | undefined {
  const normalized = normalizeRepoUrl(raw);
  if (!normalized) return undefined;
  const name = normalized.split('/').pop();
  return name && name.length > 0 ? name : undefined;
}

/** Whether two spellings refer to the same repository. */
export function isSameRepo(a: string, b: string): boolean {
  const left = normalizeRepoUrl(a);
  const right = normalizeRepoUrl(b);
  return left !== undefined && left === right;
}
