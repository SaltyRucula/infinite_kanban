import type { A2AAgentRepository } from '../repositories/a2a-agent-types.js';
import type { A2AAgent } from '../types.js';

/**
 * Consecutive failed probes before an endpoint is treated as unreachable.
 *
 * One is too eager: a restart, a GC pause or a dropped packet would strand
 * routing and escalate a healthy workflow. Three gives an endpoint a sweep or
 * two to come back before the board stops dialling it.
 */
export const UNREACHABLE_AFTER_FAILURES = 3;

/** How often reachability is re-checked. */
export const DEFAULT_PROBE_INTERVAL_MS = 30_000;

/** How long a single endpoint may take to answer before it counts as a failure. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface AgentLivenessOptions {
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly onChange?: (agent: A2AAgent) => void;
}

/**
 * Observe whether registered endpoints are still answering.
 *
 * A registration is a claim, not a guarantee: an endpoint that is killed keeps
 * its row, stays enabled, and keeps winning routing, so the board dispatches
 * into a socket nobody is listening on and the run stalls with no cause. The
 * probe re-fetches each enabled endpoint's Agent Card and records the result.
 *
 * Reachability is deliberately separate from `enabled`: enabled is an operator
 * decision, reachability is an observation. A flapping endpoint must never
 * silently become disabled, or an operator would have to re-enable it by hand
 * after every network hiccup.
 */
export class AgentLivenessProbe {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    private readonly agents: Pick<A2AAgentRepository, 'getAll' | 'recordProbe'>,
    private readonly options: AgentLivenessOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, this.options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Probe every enabled endpoint once. Never rejects: one bad endpoint must not end the sweep. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const agents = await this.agents.getAll();
      await Promise.all(agents.filter((agent) => agent.enabled).map((agent) => this.probe(agent)));
    } catch (error) {
      console.error('[liveness] could not list endpoints to probe', error);
    } finally {
      this.sweeping = false;
    }
  }

  private async probe(agent: A2AAgent): Promise<void> {
    const fetcher = this.options.fetcher ?? ((url, init) => fetch(url, init));
    const now = (this.options.now ?? Date.now)();
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, this.options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    let ok = false;
    let reason: string | undefined;
    try {
      const response = await fetcher(agent.agentCardUrl, { method: 'GET', signal: controller.signal, headers: { Accept: 'application/json' } });
      ok = response.ok;
      if (!ok) reason = `agent card responded ${response.status}`;
    } catch (error) {
      reason = error instanceof Error ? error.message : 'endpoint unreachable';
    } finally {
      clearTimeout(timeout);
    }
    try {
      const updated = await this.agents.recordProbe(agent.id, ok, now, UNREACHABLE_AFTER_FAILURES, reason);
      // Only announce a change of reachability, not every successful heartbeat.
      if (updated && Boolean(updated.unreachableSince) !== Boolean(agent.unreachableSince)) this.options.onChange?.(updated);
    } catch (error) {
      console.error(`[liveness] could not record probe for endpoint ${agent.id}`, error);
    }
  }
}
