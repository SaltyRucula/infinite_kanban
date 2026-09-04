export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Like `errorMessage`, but walks `Error.cause` chains. `fetch()` wraps
 * network-level errors (ECONNREFUSED, socket hang up, etc.) in a generic
 * "fetch failed" TypeError whose real cause is only reachable via `.cause` —
 * `errorMessage` alone silently drops that detail, making transient
 * connectivity failures unnecessarily hard to diagnose.
 */
export function errorMessageWithCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause === undefined ? err.message : `${err.message} (caused by: ${errorMessageWithCause(cause)})`;
}

export function isTransientNetworkError(error: unknown): boolean {
  const message = errorMessageWithCause(error);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|socket hang up|fetch failed|network error|connection (?:closed|reset|refused|timed out)|\b(?:408|425|429|500|502|503|504)\b/i.test(message);
}
