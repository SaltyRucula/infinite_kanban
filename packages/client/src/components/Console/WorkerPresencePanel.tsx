import { useEffect, useState } from 'react';
import { Bot, RefreshCw, X, AlertCircle } from 'lucide-react';
import type { AgentInfo } from '@/types';
import { api } from '@/lib/api';

interface WorkerPresencePanelProps {
  agents?: AgentInfo[];
  isModal?: boolean;
  onClose?: () => void;
  onRefresh?: () => void;
}

export function WorkerPresencePanel({
  agents: propAgents,
  isModal = false,
  onClose,
  onRefresh,
}: WorkerPresencePanelProps) {
  const [internalAgents, setInternalAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getAgents();
      setInternalAgents(data);
      if (onRefresh) onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch agent roster');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!propAgents) {
      void fetchAgents();
    }
  }, [propAgents]);

  const agentsList = propAgents ?? internalAgents;
  const availableCount = agentsList.filter((a) => a.available).length;

  const content = (
    <div className="flex flex-col h-full bg-[#0e1015] text-[#e2e8f0]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#202532]">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-[#00b4d8]" />
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#94a3b8]">
            Agent Roster
          </h2>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[rgba(0,180,216,0.12)] text-[#00b4d8] border border-[rgba(0,180,216,0.3)]">
            {availableCount}/{agentsList.length} Active
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void fetchAgents()}
            disabled={loading}
            className="p-1 rounded text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors disabled:opacity-50"
            title="Refresh agents"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
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

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && (
          <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-[11px]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading && agentsList.length === 0 ? (
          <div className="text-center py-6 text-[12px] text-[#94a3b8]">Loading agent pool...</div>
        ) : agentsList.length === 0 ? (
          <div className="text-center py-6 text-[12px] text-[#94a3b8]">No agent providers found.</div>
        ) : (
          agentsList.map((agent) => (
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
          ))
        )}
      </div>
    </div>
  );

  if (isModal) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="w-full max-w-md h-[480px] rounded-lg border border-[#2c3343] shadow-2xl overflow-hidden">
          {content}
        </div>
      </div>
    );
  }

  return content;
}
