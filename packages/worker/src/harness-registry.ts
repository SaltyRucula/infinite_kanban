import { Codex } from '@openai/codex-sdk';
import {
  ClaudeProvider,
  CopilotProvider,
  GrokProvider,
  HermesProvider,
  OpenClawProvider,
} from '@codewithdan/agent-sdk-core/providers';
import type { AgentEvent, AgentProvider, AgentSessionHooks } from '@codewithdan/agent-sdk-core/types';
import { createV1Adapter, createV2Adapter, spawnOpenCodeServer } from '@ai-agent-board/opencode-compat';
import type { ExecutionEndpointConfig, ExecutionHarness, HarnessInput, HarnessProgress } from './execution-types.js';

/**
 * One entry per brain the endpoint can drive.
 *
 * `readOnlyReview` is a claim about an ENFORCEMENT MECHANISM, not about a
 * prompt. The execution contract says an endpoint must refuse an assignment it
 * cannot enforce, so a harness that can only be *asked* not to edit is refused
 * the review role rather than quietly reviewing with write access.
 */
export interface HarnessEntry {
  readonly readOnlyReview: boolean;
  /** Why review is unavailable; surfaced to the operator on refusal. */
  readonly reason?: string;
  create(config: ExecutionEndpointConfig): ExecutionHarness;
}

/** Deny every mutating capability. Honoured by Copilot and the ACP providers. */
const readOnlyHooks: AgentSessionHooks = {
  onPermissionRequest: (request) => (
    ['read', 'memory'].includes(request.kind)
      ? { kind: 'approved' }
      : { kind: 'denied-by-rules' }
  ),
};

/**
 * Strip credentials and host paths from a progress line.
 *
 * Exported so the rules can be tested directly: progress becomes task history
 * the board stores and shows, so a leak here is a leak into the board.
 */
export function redactProgressContent(content: string, extraSecrets: string[] = [], directory?: string): string {
  // Matching on the variable NAME alone redacts the VALUE everywhere it appears,
  // so `API_KEY_ENABLED=true` would blank out every "true" in the log. Only
  // values long enough to be a real credential are worth substring-redacting;
  // the pattern rules below still catch structured secrets of any length.
  const MIN_SECRET_LENGTH = 12;
  const secrets = [
    ...extraSecrets,
    ...Object.entries(process.env)
      .filter(([name]) => /(?:key|token|secret|password|credential|authorization)/i.test(name))
      .map(([, value]) => value ?? ''),
  ]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  let redacted = content;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '[redacted]');
  redacted = redacted
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]')
      .replace(/\b(?:Bearer|Basic)\s+[\w.+/=-]+/gi, '[redacted]')
      .replace(/\bserver password\s+\S+/gi, '[redacted]')
      .replace(/\b[\w.-]*(?:key|token|secret|password|credential|pwd)[\w.-]*["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[redacted]')
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[\w-]+|\bAKIA[0-9A-Z]{16}\b|\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, '[redacted]')
      .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
  if (directory) redacted = redacted.replaceAll(directory, '[local workspace]');
  return redacted
    .replace(/\bfile:\/\/[^\s"'<>]+/gi, '[local path]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+|\\\\[^\s"'<>]+/g, '[local path]')
    .replace(/(^|[^\w/\]])\/(?!\/)[^\s"'`<>),;\]}]+/g, '$1[local path]');
}

/** Forward SDK events to the board as redacted, bounded progress. */
function progressReporter(input: HarnessInput, extraSecrets: string[] = []): (event: AgentEvent) => void {
  return (event) => {
    if (!input.onProgress) return;
    const content = redactProgressContent(event.content, extraSecrets, input.directory);
    let type: HarnessProgress['type'];
    switch (event.type) {
      case 'thinking': case 'tool_call': case 'command': case 'command_output': case 'file_write': case 'output':
        type = event.type;
        break;
      case 'file_read': type = 'tool_call'; break;
      case 'file_edit': type = 'file_write'; break;
      case 'test_result': type = 'command_output'; break;
      default: type = 'output';
    }
    // Observability must not change the outcome or final-text accumulation.
    try { input.onProgress({ type, content: content.slice(0, 2000) }); } catch { /* best effort */ }
  };
}

/** Drive any `AgentProvider` from the shared SDK and return its final text. */
function fromProvider(
  factory: (config: ExecutionEndpointConfig) => AgentProvider,
  enforcesReadOnly: boolean,
): HarnessEntry['create'] {
  return (config) => async (input: HarnessInput) => {
    const provider = factory(config);
    await provider.start();
    let text = '';
    const reportProgress = progressReporter(input);
    const session = await provider.createSession({
      contextId: `board-execution-${Date.now()}`,
      workingDirectory: input.directory,
      systemPrompt: input.readOnly
        ? 'You are reviewing an immutable revision. Return only the requested JSON.'
        : 'You are implementing a change in an isolated checkout. Return only the requested JSON.',
      // Output events carry the model's text; later snapshots replace earlier ones.
      onEvent: (event) => {
        reportProgress(event);
        if (event.type !== 'output') return;
        // Providers differ: some stream deltas, some resend the whole snapshot.
        // Appending a snapshot duplicates the message, so detect that case.
        if (event.metadata?.replace || (text && event.content.startsWith(text))) text = event.content;
        else text += event.content;
      },
      ...(input.readOnly && enforcesReadOnly ? { hooks: readOnlyHooks } : {}),
    });
    const timer = setTimeout(() => { void session.abort(); }, Math.max(1, input.deadline - Date.now()));
    const abort = (): void => { void session.abort(); };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await session.execute(input.prompt);
      if (result.status !== 'complete') throw new Error(result.error ?? 'harness run failed');
      return text;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      await session.destroy().catch(() => undefined);
      await provider.stop().catch(() => undefined);
    }
  };
}

/** OpenCode keeps its own adapter: review needs v2's enforced edit AND shell denies. */
const openCodeHarness: HarnessEntry['create'] = (config) => async (input: HarnessInput) => {
  const server = await spawnOpenCodeServer({ hostname: '127.0.0.1', port: 0, spawnOptions: { cwd: input.directory } });
  try {
    if (input.readOnly && server.apiVersion !== 2) {
      throw new Error('read-only review requires enforceable OpenCode v2 edit/shell permissions');
    }
    const adapter = server.apiVersion === 2
      ? createV2Adapter({
        baseUrl: server.baseUrl,
        directory: input.directory,
        password: server.serverPassword,
        turnDeadlineMs: Math.max(1, input.deadline - Date.now()),
      })
      : createV1Adapter({ baseUrl: server.baseUrl, directory: input.directory });
    const model = config.model?.split('/');
    const session = await adapter.createSession({
      title: 'Board execution',
      directory: input.directory,
      agent: 'build',
      headlessPermissions: true,
      ...(model?.length === 2 ? { model: { providerID: model[0], modelID: model[1] } } : {}),
      ...(input.readOnly
        ? { disabledTools: { edit: false, write: false, patch: false, shell: false, bash: false, webfetch: false } }
        : {}),
    });
    const progressController = new AbortController();
    const reportProgress = progressReporter(input, [server.serverPassword]);
    const abort = (): void => {
      progressController.abort();
      void adapter.interrupt(session);
      server.process.kill('SIGTERM');
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(abort, Math.max(1, input.deadline - Date.now()));
    try {
      // Start before runTurn so events emitted during the turn are observable.
      // Do not await this task: even a broken subscription must not block a turn.
      void (async () => {
        try {
          if (progressController.signal.aborted) return;
          for await (const event of adapter.subscribe(session, progressController.signal)) {
            if (progressController.signal.aborted) break;
            reportProgress(event);
          }
        } catch { /* progress is best effort, including abort/network failures */ }
      })();
      const turn = await adapter.runTurn(session, input.prompt);
      if (turn.error) throw new Error(turn.error);
      return turn.finalText ?? turn.text;
    } finally {
      progressController.abort();
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      await adapter.deleteSession(session).catch(() => undefined);
    }
  } finally {
    server.process.kill('SIGTERM');
  }
};

/** Codex is driven through its own SDK so review gets the real read-only sandbox. */
const codexHarness: HarnessEntry['create'] = (config) => async (input: HarnessInput) => {
  const thread = new Codex().startThread({
    workingDirectory: input.directory,
    model: config.model,
    sandboxMode: input.readOnly ? 'read-only' : 'workspace-write',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
  });
  const result = await thread.run(input.prompt, {
    signal: input.signal ?? AbortSignal.timeout(Math.max(1, input.deadline - Date.now())),
  });
  return result.finalResponse;
};

export const HARNESS_REGISTRY = {
  opencode: { readOnlyReview: true, create: openCodeHarness },
  codex: { readOnlyReview: true, create: codexHarness },
  copilot: {
    readOnlyReview: false,
    // Copilot honours permission denies, but it inspects files through the
    // shell, so a read-only deny list leaves it unable to read the revision at
    // all: observed ending its turn after the opening narration. Denying writes
    // while allowing shell would not be a read-only guarantee either.
    reason: 'Copilot inspects files through the shell, which a read-only review must deny',
    create: fromProvider((config) => new CopilotProvider({ ...(config.model ? { model: config.model } : {}) }), false),
  },
  // ACP exposes a permission request per tool call, so the deny list is enforced
  // by the agent's own protocol layer rather than by a prompt.
  hermes: { readOnlyReview: true, create: fromProvider(() => new HermesProvider({}), true) },
  openclaw: { readOnlyReview: true, create: fromProvider(() => new OpenClawProvider({}), true) },
  grok: { readOnlyReview: true, create: fromProvider(() => new GrokProvider({}), true) },
  claude: {
    readOnlyReview: false,
    // The Claude provider in this SDK never calls onPermissionRequest, so a deny
    // list would be decorative. Its permissionMode is set per provider instance
    // and is not a verified read-only guarantee for shell access.
    reason: 'the Claude provider ignores permission hooks, so edits cannot be prevented during review',
    create: fromProvider((config) => new ClaudeProvider({ ...(config.model ? { model: config.model } : {}) }), false),
  },
} as const satisfies Record<string, HarnessEntry>;

export type HarnessName = keyof typeof HARNESS_REGISTRY;

export function harnessNames(): HarnessName[] {
  return Object.keys(HARNESS_REGISTRY) as HarnessName[];
}

export function isHarnessName(value: string): value is HarnessName {
  return Object.hasOwn(HARNESS_REGISTRY, value);
}

export function resolveHarness(name: string): HarnessEntry['create'] {
  if (!isHarnessName(name)) {
    throw new Error(`unknown harness "${name}"; supported: ${harnessNames().join(', ')}`);
  }
  return HARNESS_REGISTRY[name].create;
}

/** The refusal message for the review role, or undefined when review is enforceable. */
export function readOnlyDenial(name: HarnessName): string | undefined {
  const entry = HARNESS_REGISTRY[name];
  if (entry.readOnlyReview) return undefined;
  return `harness "${name}" cannot take the review role: ${entry.reason}`;
}
