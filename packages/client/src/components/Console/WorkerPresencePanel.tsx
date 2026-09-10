import { useEffect, useState } from 'react';
import { Bot, RefreshCw, X, AlertCircle, Server, Cpu } from 'lucide-react';
import type { AgentInfo } from '@/types';
import { api } from '@/lib/api';
import { useWorkers } from '@/hooks/useWorkers';

interface WorkerPresencePanelProps {
  agents?: AgentInfo[];
  isModal?: boolean;
  onClose?: () => void;
  onRefresh?: () => void;
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return 'never';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function WorkerPresencePanel({
  agents: propAgents,
  isModal = false,
  onClose,
  onRefresh,
}: WorkerPresencePanelProps) {
  const [internalAgents, setInternalAgents] = useState<AgentInfo[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const { workers, loading: loadingWorkers, error: workerError, refetch: refetchWorkers } = useWorkers();

  const fetchAgents = async () => {
    setLoadingAgents(true);
    setAgentError(null);
    try {
      const data = await api.getAgents();
      setInternalAgents(data);
      if (onRefresh) onRefresh();
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : 'Failed to fetch agent roster');
    } finally {
      setLoadingAgents(false);
    }
  };

  useEffect(() => {
    if (!propAgents) {
      void fetchAgents();
    }
  }, [propAgents]);

  const handleRefreshAll = () => {
    void fetchAgents();
    void refetchWorkers();
  };

  const agentsList = propAgents ?? internalAgents;
  const availableCount = agentsList.filter((a) => a.available).length;
  const onlineWorkersCount = workers.filter((w) => w.status === 'online').length;
  const isRefreshing = loadingAgents || loadingWorkers;

  const content = (
    <div className="flex flex-col h-full bg-[#0e1015] text-[#e2e8f0]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#202532]">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-[#00b4d8]" />
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#94a3b8]">
            Worker & Agent Console
          </h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefreshAll}
            disabled={isRefreshing}
            className="p-1 rounded text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors disabled:opacity-50"
            title="Refresh agents and workers"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          {isModal && onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {(agentError || workerError) && (
          <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-[11px]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{agentError || workerError}</span>
          </div>
        )}

        {/* --- SECTION 1: REGISTERED WORKERS --- */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-emerald-400" />
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-white">
                Registered Workers
              </h3>
            </div>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              {onlineWorkersCount}/{workers.length} Online
            </span>
          </div>

          {loadingWorkers && workers.length === 0 ? (
            <div className="text-center py-4 text-[11px] text-[#94a3b8]">Loading registered workers...</div>
          ) : workers.length === 0 ? (
            <div className="p-3 rounded-md bg-[#14171e] border border-[#202532] text-center text-[11px] text-[#94a3b8] italic">
              No workers registered yet.
            </div>
          ) : (
            <div className="space-y-1.5">
              {workers.map((worker) => {
                const isOnline = worker.status === 'online';
                const isDisabled = worker.status === 'disabled';

                let statusDotColor = 'bg-[#34d399] shadow-[0_0_6px_#34d399]';
                let statusTextColor = 'text-[#34d399]';
                let statusLabel = 'Online';

                if (isDisabled) {
                  statusDotColor = 'bg-red-500';
                  statusTextColor = 'text-red-400';
                  statusLabel = 'Disabled';
                } else if (!isOnline) {
                  statusDotColor = 'bg-[#94a3b8]';
                  statusTextColor = 'text-[#94a3b8]';
                  statusLabel = 'Offline';
                }

                return (
                  <div
                    key={worker.id}
                    className="p-2.5 rounded-md bg-[#14171e] border border-[#202532] hover:border-[#2c3343] transition-colors space-y-1.5"
                  >
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-[12px] text-white truncate">
                            {worker.name}
                          </span>
                          {worker.hostname && (
                            <span className="text-[10px] font-mono text-[#94a3b8]">
                              ({worker.hostname})
                            </span>
                          )}
                          {worker.version && (
                            <span className="text-[10px] font-mono px-1 py-0.2 rounded bg-[#1b1f2b] text-[#94a3b8]">
                              v{worker.version}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-[#94a3b8] mt-0.5">
                          Last seen: {formatRelativeTime(worker.lastHeartbeatAt)}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                        <span className={`w-2 h-2 rounded-full ${statusDotColor}`} />
                        <span className={`text-[11px] font-medium ${statusTextColor}`}>
                          {statusLabel}
                        </span>
                      </div>
                    </div>

                    {worker.agentTypes && worker.agentTypes.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1 border-t border-[#1b1f2b]">
                        {worker.agentTypes.map((ag) => (
                          <span
                            key={ag}
                            className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-[#1b1f2b] text-[#00b4d8] border border-[#202532]"
                          >
                            {ag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* --- SECTION 2: AGENT PROVIDERS (PATH CLI) --- */}
        <div className="space-y-2 pt-2 border-t border-[#202532]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-[#00b4d8]" />
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[#94a3b8]">
                Agent Providers (Server CLI)
              </h3>
            </div>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[rgba(0,180,216,0.12)] text-[#00b4d8] border border-[rgba(0,180,216,0.3)]">
              {availableCount}/{agentsList.length} Active
            </span>
          </div>

          {loadingAgents && agentsList.length === 0 ? (
            <div className="text-center py-4 text-[11px] text-[#94a3b8]">Loading agent pool...</div>
          ) : agentsList.length === 0 ? (
            <div className="p-3 rounded-md bg-[#14171e] border border-[#202532] text-center text-[11px] text-[#94a3b8] italic">
              No agent providers found.
            </div>
          ) : (
            <div className="space-y-1.5">
              {agentsList.map((agent) => (
                <div
                  key={agent.name}
                  className="flex items-start justify-between p-2.5 rounded-md bg-[#14171e] border border-[#202532] hover:border-[#2c3343] transition-colors"
                >
                  <div className="flex flex-col min-w-0 pr-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[12px] text-white truncate">
                        {agent.displayName || agent.name}
                      </span>
                      <span className="text-[10px] font-mono text-[#94a3b8]">({agent.name})</span>
                      {agent.version && (
                        <span className="text-[10px] font-mono px-1 py-0.2 rounded bg-[#1b1f2b] text-[#94a3b8]">
                          v{agent.version}
                        </span>
                      )}
                    </div>
                    {!agent.available && agent.reason && (
                      <span className="text-[11px] text-slate-400 mt-0.5 truncate" title={agent.reason}>
                        {agent.reason}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        agent.available ? 'bg-[#34d399] shadow-[0_0_6px_#34d399]' : 'bg-[#94a3b8]'
                      }`}
                    />
                    <span
                      className={`text-[11px] font-medium ${
                        agent.available ? 'text-[#34d399]' : 'text-[#94a3b8]'
                      }`}
                    >
                      {agent.available ? 'Available' : 'Offline'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (isModal) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="w-full max-w-md h-[520px] rounded-lg border border-[#2c3343] shadow-2xl overflow-hidden">
          {content}
        </div>
      </div>
    );
  }

  return content;
}
