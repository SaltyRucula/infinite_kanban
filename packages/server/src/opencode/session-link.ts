export function buildOpenCodeSessionUrl(baseUrl: string, sessionId: string): string {
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, '');
  return `${trimmedBaseUrl}/session/${encodeURIComponent(sessionId)}`;
}
