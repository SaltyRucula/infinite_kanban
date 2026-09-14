import { useEffect, useState, useMemo } from 'react';
import { Bot, Check, X, Play, Server, AlertCircle, HardDrive } from 'lucide-react';
import type { Task, AgentType } from '@/types';
import { api } from '@/lib/api';
import { useWorkers } from '@/hooks/useWorkers';

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
  const [selectedAgent] = useState<AgentType>('opencode');
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { workers } = useWorkers();

  // Filter available registered workers: online + supports opencode agent type
  const matchingOnlineWorkers = useMemo(() => {
    return workers.filter(
      (w) => w.status === 'online' && (!w.agentTypes || w.agentTypes.includes('opencode')),
    );
  }, [workers]);

  useEffect(() => {
    if (isOpen && task) {
      setSelectedWorkerId(task.assignedWorkerId || null);
      setError(null);
    }
  }, [isOpen, task]);

  if (!isOpen || !task) return null;

  const handleSave = async (runNow: boolean) => {
    if (!selectedAgent) return;
    setLoading(true);
    setError(null);

    try {
      if (selectedWorkerId !== (task.assignedWorkerId || null)) {
        await api.assignWorker(task.id, selectedWorkerId);
      }
      await onAssign(selectedAgent, runNow);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to assign worker';
      if (
        msg.includes('409') ||
        msg.toLowerCase().includes('already claimed') ||
        msg.toLowerCase().includes('running') ||
        msg.toLowerCase().includes('conflict')
      ) {
        setError('Task is already claimed or running and cannot be reassigned.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-lg border border-[#2c3343] bg-[#0e1015] text-[#e2e8f0] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#202532] bg-[#08090c] shrink-0">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-[#00b4d8]" />
            <h2 className="text-[13px] font-semibold text-white">Execution & Worker Assignment</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          <div className="text-[11px] text-[#94a3b8]">
            Configure execution settings for <span className="text-white font-medium">#{task.id.slice(0, 6)}: {task.title}</span>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-2.5 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-[11px]">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Section 1: Agent Provider Type */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5 text-[#00b4d8]" />
              <label className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[#94a3b8]">
                Agent Harness
              </label>
            </div>

            <div className="p-2.5 rounded-md border border-[#00b4d8]/40 bg-[rgba(0,180,216,0.12)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#34d399]" />
                <span className="text-[12px] font-medium text-white">OpenCode / Sisyphus Worker</span>
              </div>
              <span className="text-[10px] font-mono text-[#00b4d8] uppercase font-semibold">Active</span>
            </div>
          </div>

          {/* Section 2: Registered Remote Worker Assignment */}
          <div className="space-y-2 pt-3 border-t border-[#202532]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-emerald-400" />
                <label className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[#94a3b8]">
                  Assign to Registered OpenCode Worker
                </label>
              </div>
              <span className="text-[10px] text-[#94a3b8]">Optional</span>
            </div>

            <p className="text-[11px] text-[#94a3b8] leading-tight">
              Select a remote machine running <code className="text-[#00b4d8] font-mono">@ai-agent-board/worker</code> to execute this task locally on that machine, or keep it unassigned to run in-process on the server.
            </p>

            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {/* Option: In-Process Server Execution */}
              <button
                type="button"
                onClick={() => setSelectedWorkerId(null)}
                className={`w-full flex items-center justify-between p-2.5 rounded-md border text-left transition-colors ${
                  selectedWorkerId === null
                    ? 'border-[#00b4d8] bg-[rgba(0,180,216,0.12)]'
                    : 'border-[#202532] bg-[#14171e] hover:border-[#2c3343]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <HardDrive className="w-4 h-4 text-[#00b4d8] shrink-0" />
                  <div>
                    <span className="text-[12px] font-medium text-white block">
                      In-Process Server Execution
                    </span>
                    <span className="text-[10px] text-[#94a3b8] block">
                      Unassigned — handled directly by the server&apos;s local AgentManager
                    </span>
                  </div>
                </div>
                {selectedWorkerId === null && <Check className="w-4 h-4 text-[#00b4d8] shrink-0" />}
              </button>

              {/* Registered Workers List */}
              {matchingOnlineWorkers.length === 0 ? (
                <div className="p-2.5 rounded-md bg-[#14171e]/50 border border-[#202532] text-[11px] text-[#94a3b8] text-center italic">
                  No online registered workers currently support <span className="font-mono text-[#00b4d8]">{selectedAgent}</span>.
                </div>
              ) : (
                matchingOnlineWorkers.map((worker) => {
                  const isWorkerSelected = selectedWorkerId === worker.id;

                  return (
                    <button
                      key={worker.id}
                      type="button"
                      onClick={() => setSelectedWorkerId(worker.id)}
                      className={`w-full flex items-center justify-between p-2.5 rounded-md border text-left transition-colors ${
                        isWorkerSelected
                          ? 'border-[#00b4d8] bg-[rgba(0,180,216,0.12)]'
                          : 'border-[#202532] bg-[#14171e] hover:border-[#2c3343]'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 pr-2">
                        <span className="w-2 h-2 rounded-full bg-[#34d399] shadow-[0_0_6px_#34d399] shrink-0" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[12px] font-medium text-white truncate">{worker.name}</span>
                            {worker.hostname && (
                              <span className="text-[10px] font-mono text-[#94a3b8]">({worker.hostname})</span>
                            )}
                          </div>
                          <span className="text-[10px] text-[#94a3b8] block">
                            Max concurrent: {worker.maxConcurrentTasks}
                          </span>
                        </div>
                      </div>

                      {isWorkerSelected && <Check className="w-4 h-4 text-[#00b4d8] shrink-0" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 bg-[#14171e] border-t border-[#202532] shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-[12px] font-medium text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave(false)}
            disabled={loading}
            className="px-3 py-1.5 rounded text-[12px] font-medium bg-[#1b1f2b] text-white border border-[#2c3343] hover:bg-[#202532] transition-colors disabled:opacity-50"
          >
            Assign Only
          </button>
          <button
            onClick={() => void handleSave(true)}
            disabled={loading}
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
