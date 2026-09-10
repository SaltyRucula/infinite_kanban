import { useEffect, useState } from 'react';
import { Bot, Check, X, Play } from 'lucide-react';
import type { Task, AgentType, AgentInfo } from '@/types';
import { api } from '@/lib/api';

const ALL_AGENT_TYPES: { id: AgentType; name: string }[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'copilot', name: 'GitHub Copilot' },
  { id: 'codex', name: 'Codex Agent' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'hermes', name: 'Hermes' },
  { id: 'openclaw', name: 'OpenClaw' },
  { id: 'grok', name: 'Grok' },
];

interface AssignWorkerModalProps {
  task: Task | null;
  isOpen: boolean;
  onClose: () => void;
  onAssign: (agentType: AgentType, runNow?: boolean) => Promise<void> | void;
}

export function AssignWorkerModal({
  task,
  isOpen,
  onClose,
  onAssign,
}: AssignWorkerModalProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentType | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      void api.getAgents().then(setAgents).catch(console.error);
      setSelectedAgent(task?.agentType || 'claude');
    }
  }, [isOpen, task]);

  if (!isOpen || !task) return null;

  const handleSave = async (runNow: boolean) => {
    if (!selectedAgent) return;
    setLoading(true);
    try {
      await onAssign(selectedAgent, runNow);
      onClose();
    } catch (err) {
      console.error('Failed to assign worker:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-lg border border-[#2c3343] bg-[#0e1015] text-[#e2e8f0] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#202532]">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-[#00b4d8]" />
            <h2 className="text-[13px] font-semibold text-white">Assign Worker Agent</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-[11px] text-[#94a3b8]">
            Select an execution agent for <span className="text-white font-medium">#{task.id.slice(0, 6)}: {task.title}</span>
          </p>

          <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
            {ALL_AGENT_TYPES.map((agent) => {
              const info = agents.find((a) => a.name === agent.id);
              const isAvailable = info ? info.available : true;
              const isSelected = selectedAgent === agent.id;

              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setSelectedAgent(agent.id)}
                  className={`w-full flex items-center justify-between p-2.5 rounded-md border text-left transition-colors ${
                    isSelected
                      ? 'border-[#00b4d8] bg-[rgba(0,180,216,0.12)]'
                      : 'border-[#202532] bg-[#14171e] hover:border-[#2c3343]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        isAvailable ? 'bg-[#34d399]' : 'bg-[#94a3b8]'
                      }`}
                    />
                    <span className="text-[12px] font-medium text-white">{agent.name}</span>
                    <span className="text-[10px] font-mono text-[#94a3b8]">({agent.id})</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-medium ${
                        isAvailable ? 'text-[#34d399]' : 'text-[#94a3b8]'
                      }`}
                    >
                      {isAvailable ? 'Available' : 'Offline'}
                    </span>
                    {isSelected && <Check className="w-4 h-4 text-[#00b4d8]" />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 bg-[#14171e] border-t border-[#202532]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-[12px] font-medium text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave(false)}
            disabled={loading || !selectedAgent}
            className="px-3 py-1.5 rounded text-[12px] font-medium bg-[#1b1f2b] text-white border border-[#2c3343] hover:bg-[#202532] transition-colors disabled:opacity-50"
          >
            Assign Only
          </button>
          <button
            onClick={() => void handleSave(true)}
            disabled={loading || !selectedAgent}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-semibold bg-[#00b4d8] text-slate-950 hover:bg-[#38bdf8] transition-colors disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            Assign & Run
          </button>
        </div>
      </div>
    </div>
  );
}
