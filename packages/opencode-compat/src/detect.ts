// Chunk 0 of opencode v1/v2 support (relocated here in chunk 1): `opencode
// serve` v2 changed its startup banner (dropped the "opencode " prefix) and
// moved its JSON API under `/api/`, so a v2 server that we mistake for v1
// will fail in confusing ways deep inside session calls instead of at
// startup. This module centralizes the two pieces of logic needed to fail
// fast and clearly instead: the banner regex (which must match both v1 and
// v2) and the post-connect version probe that distinguishes them.
//
// This used to live in `shared/opencode-version-probe.ts`, imported directly
// by both the worker's local-runner and the server's non-destructive-provider.
// It moved into this server-only compat package because `shared/` is also
// imported by `packages/client` (browser code), and this probe — like the
// rest of opencode v1/v2 wire-protocol handling — is a server-only concern
// that must not accumulate in a package shared with the browser bundle.

/**
 * Matches the "server listening on http://host:port" banner that
 * `opencode serve` prints to stdout/stderr on startup.
 *
 * - v1 prints: `opencode server listening on http://127.0.0.1:PORT`
 * - v2 prints: `server listening on http://127.0.0.1:PORT` (no `opencode` prefix)
 *
 * The optional non-capturing `(?:opencode\s+)?` prefix is what makes this a
 * union of both formats; capture group 1 is always the URL.
 */
export const OPENCODE_SERVER_LISTENING_REGEX = /(?:opencode\s+)?server listening on\s+(https?:\/\/\S+)/i;

const OPENCODE_INFO_PROBE_TIMEOUT_MS = 2_000;

export type OpenCodeVersionProbeResult =
  | { readonly kind: 'v1' }
  | { readonly kind: 'v2-or-newer'; readonly version: string }
  | { readonly kind: 'unauthorized' };

/**
 * Probes `{baseUrl}/api/info` to distinguish an opencode v1 server (which has
 * no such endpoint — v1's JSON API is unprefixed) from v2+ (whose API lives
 * under `/api/` and requires HTTP Basic auth using the server password we
 * inject at spawn time).
 *
 * Decision table (see spawn.ts for how each result is handled):
 * - 200 + JSON body with a `version` string -> `{ kind: 'v2-or-newer', version }`.
 *   This build has no v2 API client, so callers must treat this as fatal.
 * - 401 -> `{ kind: 'unauthorized' }`. This must NEVER be treated as "assume
 *   v1" — a v2 server that rejected our credentials is still a v2 server,
 *   and silently guessing wrong is exactly the failure mode this probe
 *   exists to eliminate.
 * - 404, a non-JSON body, a connection error, or a timeout -> `{ kind: 'v1' }`.
 *   This is the healthy, expected path for a real v1 server, which has no
 *   `/api/info` endpoint at all.
 */
export async function probeOpenCodeVersion(
  baseUrl: string,
  password: string,
  timeoutMs: number = OPENCODE_INFO_PROBE_TIMEOUT_MS,
): Promise<OpenCodeVersionProbeResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const infoUrl = new URL('/api/info', baseUrl).toString();
    const auth = Buffer.from(`opencode:${password}`, 'utf8').toString('base64');
    const response = await fetch(infoUrl, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });

    if (response.status === 401) {
      return { kind: 'unauthorized' };
    }
    if (response.status !== 200) {
      // Includes 404 (the expected v1 response) and any other non-success
      // status: none of those tell us anything reliable other than "not a
      // v2 server we can positively identify", so treat as v1.
      return { kind: 'v1' };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      // A 200 with a non-JSON body (e.g. v1 serving its unrelated web UI, or
      // some other HTML/plaintext response) must not be mistaken for v2's
      // JSON API.
      return { kind: 'v1' };
    }

    const body: unknown = await response.json();
    const version = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).version
      : undefined;
    if (typeof version === 'string' && version.length > 0) {
      return { kind: 'v2-or-newer', version };
    }
    // 200 + JSON but no recognizable version field — not enough signal to
    // call this v2, so fall through to the safe default.
    return { kind: 'v1' };
  } catch {
    // Connection error, timeout (AbortError), or JSON parse failure: all
    // read as "no usable /api/info", i.e. v1.
    return { kind: 'v1' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Builds the fatal error message for a positively-identified v2+ server.
 * Shared so the worker and server paths report byte-identical wording.
 */
export function formatOpenCodeV2DetectedError(baseUrl: string, version: string): string {
  return `opencode v${version} detected at ${baseUrl}, but this build supports opencode v1 only. `
    + 'Install opencode v1 (npm i -g opencode-ai@1) or track v2 support.';
}

/** Error for a probe that got a 401 — never downgraded to "assume v1". */
export function formatOpenCodeUnauthorizedError(): string {
  return 'opencode server rejected our credentials (401) — cannot determine version';
}

/**
 * Redacts secrets that can leak into raw opencode server stdout/stderr
 * before it is interpolated into an error message that reaches the event
 * stream / database:
 * - v2, when no `OPENCODE_SERVER_PASSWORD` is preset before spawn, prints a
 *   second startup line: `server password <generated-secret>`. Redact that
 *   pattern generically (case-insensitive) regardless of value.
 * - The specific per-spawn password we generate and inject (see
 *   `OPENCODE_SERVER_PASSWORD` at each spawn site) is also redacted
 *   explicitly, in case it appears anywhere else in the captured output.
 */
export function redactOpenCodeSecrets(text: string, generatedPassword?: string): string {
  let redacted = text.replace(/server password\s+\S+/gi, 'server password [redacted]');
  if (generatedPassword) {
    redacted = redacted.split(generatedPassword).join('[redacted]');
  }
  return redacted;
}
