import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Bot, Moon, Plus, RefreshCw, Sun, Trash2 } from 'lucide-react';
import type { A2AAgent, A2AWorkflowRole, Project } from '@/types';
import { api } from '@/lib/api';

interface A2AConsoleProps {
  project: Project;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  onBackToProjects: () => void;
  onOpenBoard: () => void;
}

function projectRoles(agent: A2AAgent, projectId: string): A2AWorkflowRole[] {
  return agent.projectAccess.find((access) => access.projectId === projectId)?.roles ?? [];
}

export function A2AConsole({ project, theme, toggleTheme, onBackToProjects, onOpenBoard }: A2AConsoleProps) {
  const [agents, setAgents] = useState<A2AAgent[]>([]);
  const [agentCardUrl, setAgentCardUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      setAgents(await api.getA2AAgents());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the A2A agent directory.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAgents(); }, [loadAgents]);

  const updateAgent = useCallback((updated: A2AAgent | undefined) => {
    if (updated) setAgents((current) => current.map((agent) => agent.id === updated.id ? updated : agent));
  }, []);

  const register = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!agentCardUrl.trim()) return;
    setSubmitting(true);
    try {
      const registered = await api.registerA2AAgent(agentCardUrl.trim());
      setAgents((current) => [...current, registered]);
      setAgentCardUrl('');
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not register the Agent Card.');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleRole = async (agent: A2AAgent, role: A2AWorkflowRole) => {
    const roles = projectRoles(agent, project.id);
    const nextRoles = roles.includes(role) ? roles.filter((item) => item !== role) : [...roles, role];
    try {
      updateAgent(await api.setA2AAgentProjectRoles(agent.id, project.id, nextRoles));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update project roles.');
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h1 className="text-xl font-semibold">A2A Console</h1>
          <p className="text-sm text-muted-foreground">{project.name} · board-managed remote agent workflows</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onOpenBoard} className="rounded border border-border px-3 py-2 text-sm hover:bg-muted">Board view</button>
          <button onClick={onBackToProjects} aria-label="Back to projects" className="rounded border border-border p-2 hover:bg-muted"><ArrowLeft className="h-4 w-4" /></button>
          <button onClick={toggleTheme} aria-label="Toggle theme" className="rounded border border-border p-2 hover:bg-muted">{theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Agent Directory</h2>
              <p className="text-sm text-muted-foreground">Register trusted Agent Cards and grant this project workflow roles.</p>
            </div>
            <button onClick={() => void loadAgents()} aria-label="Refresh directory" className="rounded border border-border p-2 hover:bg-muted"><RefreshCw className="h-4 w-4" /></button>
          </div>
          <form onSubmit={register} className="mb-5 flex gap-2">
            <label className="sr-only" htmlFor="agent-card-url">Agent Card URL</label>
            <input id="agent-card-url" value={agentCardUrl} onChange={(event) => setAgentCardUrl(event.target.value)} placeholder="https://agent.example/.well-known/agent-card.json" className="min-w-0 flex-1 rounded border border-input bg-background px-3 py-2 text-sm" />
            <button type="submit" disabled={submitting || !agentCardUrl.trim()} className="inline-flex items-center gap-1 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"><Plus className="h-4 w-4" />Register</button>
          </form>
          {error && <p role="alert" className="mb-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600">{error}</p>}
          {loading ? <p className="text-sm text-muted-foreground">Loading A2A agent directory…</p> : agents.length === 0 ? <p className="rounded border border-dashed border-border p-5 text-sm text-muted-foreground">No A2A agents registered yet.</p> : (
            <ul className="space-y-3">
              {agents.map((agent) => {
                const roles = projectRoles(agent, project.id);
                return <li key={agent.id} className="rounded border border-border p-4">
                  <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2 font-medium"><Bot className="h-4 w-4" />{agent.name}</div><p className="mt-1 text-sm text-muted-foreground">{agent.description || agent.endpoint}</p>{agent.lastValidationError && <p className="mt-1 text-sm text-red-600">Last refresh: {agent.lastValidationError}</p>}</div><div className="flex gap-1"><button onClick={() => void api.refreshA2AAgent(agent.id).then(updateAgent).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not refresh Agent Card.'))} aria-label={`Refresh ${agent.name}`} className="rounded border border-border p-2 hover:bg-muted"><RefreshCw className="h-4 w-4" /></button><button onClick={() => void api.deleteA2AAgent(agent.id).then(() => setAgents((current) => current.filter((item) => item.id !== agent.id))).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not delete Agent Card.'))} aria-label={`Delete ${agent.name}`} className="rounded border border-border p-2 hover:bg-muted"><Trash2 className="h-4 w-4" /></button></div></div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm"><button onClick={() => void api.setA2AAgentEnabled(agent.id, !agent.enabled).then(updateAgent).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not change agent status.'))} className="rounded border border-border px-2 py-1 hover:bg-muted">{agent.enabled ? 'Enabled' : 'Disabled'}</button>{(['implementation', 'review'] as const).map((role) => <label key={role} className="flex items-center gap-1"><input type="checkbox" checked={roles.includes(role)} onChange={() => void toggleRole(agent, role)} />{role}</label>)}</div>
                </li>;
              })}
            </ul>
          )}
        </section>
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold">Workflow History</h2>
          <p className="mt-1 text-sm text-muted-foreground">Implementation and review runs will appear here as the A2A dispatcher records them.</p>
          <p className="mt-5 rounded border border-dashed border-border p-5 text-sm text-muted-foreground">No workflow runs have been recorded for this project.</p>
        </section>
      </main>
    </div>
  );
}
