export function buildOpenCodeSessionUrl(baseUrl: string, sessionId: string): string {
  void sessionId;
  return baseUrl.replace(/\/+$/, '');
}
