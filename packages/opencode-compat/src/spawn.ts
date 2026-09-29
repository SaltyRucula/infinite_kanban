import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import {
  formatOpenCodeUnauthorizedError,
  OPENCODE_SERVER_LISTENING_REGEX,
  probeOpenCodeVersion,
  redactOpenCodeSecrets,
} from './detect.js';

const DEFAULT_HOSTNAME = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_BANNER_TIMEOUT_MS = 5_000;

/**
 * Minimal process shape both spawn sites need: local-runner's injectable
 * `spawnFn` test seam returns a `child_process.ChildProcess`-compatible
 * fake, and non-destructive-provider's real `ChildProcess` satisfies this
 * structurally too.
 */
export interface OpenCodeProcessLike {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type OpenCodeSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => OpenCodeProcessLike;

export type SpawnOpenCodeServerOptions = {
  /** Default '127.0.0.1'. */
  readonly hostname?: string;
  /** Default 0 (OS-assigned ephemeral port). */
  readonly port?: number;
  /** Injectable spawn function (test seam). Defaults to `node:child_process`'s `spawn`. */
  readonly spawnFn?: OpenCodeSpawnFn;
  /**
   * Already-spawned process to probe instead of spawning a new one (used
   * when a caller supplies its own `managedServer` handle). When set,
   * `spawnFn` is not called at all.
   */
  readonly existingProcess?: OpenCodeProcessLike;
  /** Extra options merged into the spawn call (e.g. `{ shell: false }` or `{ detached: true }`). `env` is merged separately — see `env` below. */
  readonly spawnOptions?: Omit<SpawnOptionsWithoutStdio, 'env'>;
  /** Extra env vars merged over `process.env`, before `OPENCODE_SERVER_PASSWORD` is added (which always wins). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly bannerTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  /**
   * How to stop the process if the version probe positively identifies a
   * v2+ server (or a 401) — this is fatal, so the process is torn down
   * before throwing. Defaults to a plain `SIGTERM`; non-destructive-provider
   * passes its own process-group-aware stop function since it spawns
   * `detached: true`.
   */
  readonly stopOnFatal?: (proc: OpenCodeProcessLike) => void | Promise<void>;
};

export type SpawnedOpenCodeServer = {
  readonly baseUrl: string;
  readonly process: OpenCodeProcessLike;
  /**
   * The per-spawn password injected via `OPENCODE_SERVER_PASSWORD`. v1
   * ignores it (harmless no-op); v2 uses it as its HTTP Basic auth password
   * instead of generating and printing its own random one to stdout (the
   * credential leak `redactOpenCodeSecrets` also guards against
   * defensively). It is also the credential used for the `/api/info`
   * version probe below.
   */
  readonly serverPassword: string;
  /**
   * The version this spawn's `/api/info` probe positively identified.
   * Callers use this to pick `createV1Adapter` vs `createV2Adapter` (see
   * `@ai-agent-board/opencode-compat`'s index.ts) instead of guessing —
   * this build no longer treats a positively-identified v2+ server as
   * fatal (see the module doc comment below).
   */
  readonly apiVersion: 1 | 2;
  /** Only set when `apiVersion` is 2 — the raw version string `/api/info` reported. */
  readonly detectedVersion?: string;
};

function defaultSpawnFn(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio): OpenCodeProcessLike {
  return nodeSpawn(command, [...args], options);
}

function waitForBanner(proc: OpenCodeProcessLike, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for opencode serve to report a listening URL after ${timeoutMs}ms`));
    }, timeoutMs);
    let output = '';

    const onOutput = (chunk: string | Buffer): void => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Union regex: v1 prints "opencode server listening on ..." while v2
      // dropped the "opencode " prefix and prints just "server listening on
      // ...". Matching both here means startup no longer hangs for the
      // full timeout on a v2 server before the version probe below gets a
      // chance to produce a clear, actionable error.
      const match = output.match(OPENCODE_SERVER_LISTENING_REGEX);
      if (!match) return;
      cleanup();
      resolve(match[1]);
    };

    const onClose = (code: number | null): void => {
      cleanup();
      // Include (redacted) captured output for debuggability: on v2, when no
      // password was preset before spawn, this can contain a
      // `server password <secret>` line — redact it defensively even though
      // we always inject our own OPENCODE_SERVER_PASSWORD below, in case a
      // future code path spawns without doing so.
      const detail = output.trim() ? `\nServer output: ${redactOpenCodeSecrets(output)}` : '';
      reject(new Error(`opencode serve exited before startup with code ${code ?? 'unknown'}${detail}`));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      proc.stdout.off('data', onOutput);
      proc.stderr.off('data', onOutput);
      proc.off('close', onClose);
      proc.off('error', onError);
    };

    proc.stdout.on('data', onOutput);
    proc.stderr.on('data', onOutput);
    proc.on('close', onClose);
    proc.on('error', onError);
  });
}

/**
 * Spawns (or adopts an already-spawned) `opencode serve` process, waits for
 * its startup banner, and positively identifies its API version via
 * `/api/info` so a caller can pick the matching adapter
 * (`createV1Adapter`/`createV2Adapter`) instead of guessing.
 *
 * A 401 is still fatal here — and still stops the process before throwing —
 * because a v2+ server that rejected our credentials must never be
 * downgraded to "assume v1"; there is no adapter that could safely proceed
 * without knowing which protocol it is speaking. A real v1 server has no
 * `/api/info` endpoint at all, so 404/non-JSON/connection-error/timeout all
 * correctly fall through as "v1, continue". A positively-identified v2+
 * server used to be fatal too (this build had no v2 API client yet); now
 * that `createV2Adapter` exists, `apiVersion: 2` is returned instead so the
 * caller can construct it — see `@ai-agent-board/opencode-compat`'s
 * `defaultCreateAdapter`-equivalent in local-runner.ts for the selection
 * logic, and `createV2Adapter`'s own doc comment for why routing v2 through
 * the anti-hang watcher (chunk 4) was the prerequisite for this change.
 */
export async function spawnOpenCodeServer(options: SpawnOpenCodeServerOptions = {}): Promise<SpawnedOpenCodeServer> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const port = options.port ?? DEFAULT_PORT;
  const spawnFn = options.spawnFn ?? defaultSpawnFn;
  const bannerTimeoutMs = options.bannerTimeoutMs ?? DEFAULT_BANNER_TIMEOUT_MS;

  // Generated fresh per spawn (never reused, never persisted) and injected
  // via OPENCODE_SERVER_PASSWORD below.
  const serverPassword = randomBytes(32).toString('base64url');

  const proc = options.existingProcess ?? spawnFn(
    'opencode',
    ['serve', `--hostname=${hostname}`, `--port=${port}`],
    {
      ...options.spawnOptions,
      env: { ...process.env, ...options.env, OPENCODE_SERVER_PASSWORD: serverPassword },
    },
  );

  const baseUrl = await waitForBanner(proc, bannerTimeoutMs);

  const probe = await probeOpenCodeVersion(baseUrl, serverPassword, options.probeTimeoutMs);
  if (probe.kind === 'unauthorized') {
    await (options.stopOnFatal ?? defaultStopOnFatal)(proc);
    throw new Error(formatOpenCodeUnauthorizedError());
  }
  if (probe.kind === 'v2-or-newer') {
    return { baseUrl, process: proc, serverPassword, apiVersion: 2, detectedVersion: probe.version };
  }

  return { baseUrl, process: proc, serverPassword, apiVersion: 1 };
}

function defaultStopOnFatal(proc: OpenCodeProcessLike): void {
  proc.kill('SIGTERM');
}
