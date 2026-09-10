import { useState, useEffect } from 'react';
import {
  X,
  Play,
  Square,
  ExternalLink,
  GitBranch,
  GitMerge,
  Trash2,
  Bot,
  Send,
  HelpCircle,
} from 'lucide-react';
import type { Task, AgentEvent, Priority, ColumnId } from '@/types';
import { api, connectWS } from '@/lib/api';

interface TaskDetailPanelProps {
  task: Task | null;
  isOpen: boolean;
  onClose: () => void;
  onRunTask: (taskId: string) => void;
  onStopTask: (taskId: string) => void;
  onOpenOpenCode: (task: Task) => void;
  onCreatePR: (taskId: string) => Promise<string | undefined>;
  onMergeLocal: (taskId: string) => Promise<string | undefined>;
  onCleanupWorktree: (taskId: string) => Promise<void>;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => Promise<Task | undefined>;
  onResumeClarification: (
    taskId: string,
    data: { requestId: string; sessionId: string; answer: string }
  ) => Promise<unknown>;
  onOpenAssignModal?: (task: Task) => void;
}

export function TaskDetailPanel({
  task,
  isOpen,
  onClose,
  onRunTask,
  onStopTask,
  onOpenOpenCode,
  onCreatePR,
  onMergeLocal,
  onCleanupWorktree,
  onUpdateTask,
  onResumeClarification,
  onOpenAssignModal,
}: TaskDetailPanelProps) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!task || !isOpen) {
      setEvents([]);
      setPrUrl(null);
      setActionMessage(null);
      return;
    }

    setLoadingEvents(true);
    api
      .getEvents(task.id)
      .then(setEvents)
      .catch(console.error)
      .finally(() => setLoadingEvents(false));

    return connectWS((msg) => {
      if (msg.type === 'agent_event' && msg.payload.taskId === task.id) {
        setEvents((prev) => [...prev, msg.payload]);
      }
    });
  }, [task?.id, isOpen]);

  if (!isOpen || !task) return null;

  const isRunning = task.agentStatus === 'executing' || task.agentStatus === 'planning';

  const handleClarificationSubmit = async (answerText?: string) => {
    const textToSubmit = answerText ?? clarificationAnswer;
    if (!task.clarificationRequest || !textToSubmit.trim()) return;

    setSubmittingAnswer(true);
    try {
      await onResumeClarification(task.id, {
        requestId: task.clarificationRequest.requestId,
        sessionId: task.clarificationRequest.sessionId,
        answer: textToSubmit.trim(),
      });
      setClarificationAnswer('');
    } catch (err) {
      console.error('Failed to submit clarification:', err);
    } finally {
      setSubmittingAnswer(false);
    }
  };

  const handlePR = async () => {
    setActionLoading('pr');
    setActionMessage(null);
    try {
      const url = await onCreatePR(task.id);
      if (url) {
        setPrUrl(url);
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } finally {
      setActionLoading(null);
    }
  };

  const handleMerge = async () => {
    setActionLoading('merge');
    setActionMessage(null);
    try {
      const base = await onMergeLocal(task.id);
      if (base) setActionMessage(`Merged into ${base}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCleanup = async () => {
    setActionLoading('cleanup');
    setActionMessage(null);
    try {
      await onCleanupWorktree(task.id);
      setActionMessage('Worktree cleaned up');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0e1015] text-[#e2e8f0] border-l border-[#202532] w-[400px] shrink-0 overflow-hidden shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#202532] bg-[#08090c]">
        <div className="flex items-center gap-2 min-w-0 pr-2">
          <span className="font-mono text-[11px] font-semibold text-[#00b4d8] px-1.5 py-0.5 rounded bg-[rgba(0,180,216,0.12)] border border-[rgba(0,180,216,0.3)]">
            #{task.id.slice(0, 6)}
          </span>
          <h2 className="text-[13px] font-semibold text-white truncate">{task.title}</h2>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <div className="flex flex-wrap gap-2">
          {isRunning ? (
            <button
              onClick={() => onStopTask(task.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              Stop Agent
            </button>
          ) : (
            <button
              onClick={() => onRunTask(task.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-semibold bg-[#00b4d8] text-slate-950 hover:bg-[#38bdf8] transition-colors"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              Run Agent
            </button>
          )}

          <button
            onClick={() => onOpenAssignModal?.(task)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#14171e] text-[#e2e8f0] border border-[#2c3343] hover:bg-[#1b1f2b] transition-colors"
          >
            <Bot className="w-3.5 h-3.5 text-[#00b4d8]" />
            Worker: {task.agentType || 'copilot'}
          </button>

          <button
            onClick={() => onOpenOpenCode(task)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium bg-[#14171e] text-[#e2e8f0] border border-[#2c3343] hover:bg-[#1b1f2b] transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5 text-purple-400" />
            OpenCode
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px] bg-[#14171e] p-3 rounded-lg border border-[#202532]">
          <div>
            <span className="text-[#94a3b8] block text-[10px] uppercase font-semibold">Column</span>
            <select
              value={task.columnId}
              onChange={(e) => void onUpdateTask(task.id, { columnId: e.target.value as ColumnId })}
              className="mt-1 bg-[#08090c] border border-[#2c3343] rounded px-2 py-1 text-white text-[11px] w-full focus:outline-none focus:border-[#00b4d8]"
            >
              <option value="backlog">Backlog</option>
              <option value="in-progress">In Progress</option>
              <option value="pending">Pending</option>
              <option value="review">Review</option>
              <option value="done">Done</option>
            </select>
          </div>

          <div>
            <span className="text-[#94a3b8] block text-[10px] uppercase font-semibold">Priority</span>
            <select
              value={task.priority}
              onChange={(e) => void onUpdateTask(task.id, { priority: e.target.value as Priority })}
              className="mt-1 bg-[#08090c] border border-[#2c3343] rounded px-2 py-1 text-white text-[11px] w-full focus:outline-none focus:border-[#00b4d8]"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          <div>
            <span className="text-[#94a3b8] block text-[10px] uppercase font-semibold">Status</span>
            <span className="mt-1 inline-block font-mono text-[11px] text-white bg-[#08090c] px-2 py-1 rounded border border-[#2c3343] w-full">
              {task.agentStatus}
            </span>
          </div>

          <div>
            <span className="text-[#94a3b8] block text-[10px] uppercase font-semibold">Timeout</span>
            <span className="mt-1 inline-block font-mono text-[11px] text-[#94a3b8] bg-[#08090c] px-2 py-1 rounded border border-[#2c3343] w-full">
              {task.timeoutMinutes ? `${task.timeoutMinutes}m` : 'Default'}
            </span>
          </div>
        </div>

        {task.clarificationRequest && (
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[12px] space-y-2">
            <div className="flex items-center gap-1.5 font-semibold text-amber-400">
              <HelpCircle className="w-4 h-4 shrink-0" />
              <span>Clarification Needed</span>
            </div>
            <p className="text-amber-200">{task.clarificationRequest.prompt}</p>

            {task.clarificationRequest.choices && task.clarificationRequest.choices.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {task.clarificationRequest.choices.map((choice) => (
                  <button
                    key={choice}
                    disabled={submittingAnswer}
                    onClick={() => void handleClarificationSubmit(choice)}
                    className="px-2.5 py-1 rounded text-[11px] bg-amber-500/20 hover:bg-amber-500/40 text-amber-100 border border-amber-500/40 transition-colors"
                  >
                    {choice}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex gap-2 pt-1">
                <input
                  type="text"
                  value={clarificationAnswer}
                  onChange={(e) => setClarificationAnswer(e.target.value)}
                  placeholder="Type your response..."
                  className="flex-1 bg-[#08090c] border border-amber-500/40 rounded px-2.5 py-1 text-[11px] text-white focus:outline-none focus:border-amber-400"
                />
                <button
                  disabled={submittingAnswer || !clarificationAnswer.trim()}
                  onClick={() => void handleClarificationSubmit()}
                  className="px-3 py-1 bg-amber-500 text-slate-950 font-semibold rounded text-[11px] hover:bg-amber-400 disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {actionMessage && (
          <div className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px]">
            {actionMessage}
          </div>
        )}

        <div className="space-y-1.5">
          <h3 className="text-[11px] uppercase tracking-[0.05em] font-semibold text-[#94a3b8]">
            Git & Worktree
          </h3>
          <div className="space-y-1 bg-[#14171e] p-2.5 rounded-lg border border-[#202532] text-[11px] font-mono">
            {task.repoPath && (
              <div className="truncate text-[#94a3b8]">
                Repo: <span className="text-white">{task.repoPath}</span>
              </div>
            )}
            {task.branchName && (
              <div className="truncate text-[#94a3b8]">
                Branch: <span className="text-[#00b4d8]">{task.branchName}</span>
              </div>
            )}
            {task.worktreePath && (
              <div className="truncate text-[#94a3b8]">
                Worktree: <span className="text-amber-400">{task.worktreePath}</span>
              </div>
            )}
            {prUrl && (
              <div className="truncate text-[#94a3b8] pt-1">
                PR URL: <a href={prUrl} target="_blank" rel="noopener noreferrer" className="text-[#00b4d8] underline">{prUrl}</a>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={() => void handlePR()}
              disabled={actionLoading === 'pr'}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-[#14171e] text-[#e2e8f0] border border-[#2c3343] hover:bg-[#1b1f2b] transition-colors disabled:opacity-50"
            >
              <GitBranch className="w-3.5 h-3.5 text-blue-400" />
              Create PR
            </button>

            <button
              onClick={() => void handleMerge()}
              disabled={actionLoading === 'merge'}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-[#14171e] text-[#e2e8f0] border border-[#2c3343] hover:bg-[#1b1f2b] transition-colors disabled:opacity-50"
            >
              <GitMerge className="w-3.5 h-3.5 text-purple-400" />
              Merge Local
            </button>

            {task.worktreePath && (
              <button
                onClick={() => void handleCleanup()}
                disabled={actionLoading === 'cleanup'}
                className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-[#14171e] text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clean Worktree
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <h3 className="text-[11px] uppercase tracking-[0.05em] font-semibold text-[#94a3b8]">
            Description
          </h3>
          <div className="p-3 rounded-lg bg-[#14171e] border border-[#202532] text-[12px] leading-relaxed text-[#e2e8f0] whitespace-pre-wrap">
            {task.description || 'No description provided.'}
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-[0.05em] font-semibold text-[#94a3b8]">
            Agent Execution Stream ({events.length})
          </h3>
          <div className="bg-[#08090c] border border-[#202532] rounded-lg p-2.5 max-h-56 overflow-y-auto font-mono text-[10px] space-y-1.5">
            {loadingEvents ? (
              <div className="text-center py-4 text-[#94a3b8]">Loading events...</div>
            ) : events.length === 0 ? (
              <div className="text-center py-4 text-[#94a3b8]">No events recorded yet.</div>
            ) : (
              events.map((ev) => (
                <div key={ev.id} className="p-1.5 rounded bg-[#14171e] border border-[#202532]">
                  <div className="flex items-center justify-between text-[#94a3b8] mb-0.5">
                    <span className="font-semibold text-[#00b4d8]">{ev.type}</span>
                    <span>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <pre className="text-[#e2e8f0] whitespace-pre-wrap break-words">{ev.content}</pre>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
