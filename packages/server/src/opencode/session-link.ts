/**
 * The OpenCode web app's client-side router encodes the session's working
 * directory as a base64 path segment (`Buffer.from(dir).toString('base64')`,
 * padding kept) before `/session/:id`. This is reverse-engineered from the
 * app's own navigation (confirmed live), not documented by OpenCode.
 */
export function buildOpenCodeSessionUrl(baseUrl: string, directory: string, sessionId: string): string {
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, '');
  const encodedDirectory = Buffer.from(directory, 'utf8').toString('base64');
  return `${trimmedBaseUrl}/${encodedDirectory}/session/${encodeURIComponent(sessionId)}`;
}
