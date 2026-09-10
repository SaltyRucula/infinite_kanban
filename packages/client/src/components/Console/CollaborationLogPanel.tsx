import { useEffect, useState, useRef } from 'react';
import { Activity, X, Terminal, ArrowRight, CheckCircle2 } from 'lucide-react';
import type { WSMessage } from '@/types';
import { connectWS } from '@/lib/api';

interface LogEntry {
  id: string;
  timestamp: Date;
  taskId?: string;
  title: string;
  detail: string;
  kind: 'update' | 'event' | 'complete' | 'status';
}

interface CollaborationLogPanelProps {
  onSelectTask?: (taskId: string) => void;
  onClose?: () => void;
  isOpen?: boolean;
}

export function CollaborationLogPanel({
  onSelectTask,
  onClose,
  isOpen = true,
}: CollaborationLogPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return connectWS((msg: WSMessage) => {
      const now = new Date();

      if (msg.type === 'task_updated') {
        const task = msg.payload;
        setLogs((prev) => [
          {
            id: `task-${task.id}-${now.getTime()}-${Math.random()}`,
            timestamp: now,
            taskId: task.id,
            title: `Task #${task.id.slice(0, 6)}`,
            detail: `Status: ${task.agentStatus} | Column: ${task.columnId}`,
            kind: 'update',
          },
          ...prev.slice(0, 99),
        ]);
      } else if (msg.type === 'agent_event') {
        const ev = msg.payload;
        setLogs((prev) => [
          {
            id: `ev-${ev.id}-${now.getTime()}`,
            timestamp: now,
            taskId: ev.taskId,
            title: `Agent (${ev.type})`,
            detail: ev.content.length > 80 ? `${ev.content.slice(0, 80)}...` : ev.content,
            kind: 'event',
          },
          ...prev.slice(0, 99),
        ]);
      } else if (msg.type === 'agent_complete') {
        const p = msg.payload;
        setLogs((prev) => [
          {
            id: `comp-${p.taskId}-${now.getTime()}`,
            timestamp: now,
            taskId: p.taskId,
            title: `Execution ${p.status}`,
            detail: `Agent ${p.agentType || ''} finished in ${(p.duration / 1000).toFixed(1)}s`,
            kind: 'complete',
          },
          ...prev.slice(0, 99),
        ]);
      }
    });
  }, []);

  if (!isOpen) return null;

  return (
    <div className="flex flex-col h-full bg-[#0e1015] text-[#e2e8f0] border-l border-[#202532] w-80 shrink-0">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#202532]">
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-[#00b4d8]" />
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#94a3b8]">
            Live Event Feed
          </h2>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-1.5 font-mono text-[11px]">
        {logs.length === 0 ? (
          <div className="text-center py-8 text-[#94a3b8] font-sans text-[12px]">
            Waiting for live agent events...
          </div>
        ) : (
          logs.map((log) => (
            <div
              key={log.id}
              onClick={() => log.taskId && onSelectTask?.(log.taskId)}
              className={`p-2 rounded border border-[#202532] bg-[#14171e] hover:border-[#2c3343] transition-colors ${
                log.taskId ? 'cursor-pointer hover:bg-[#1b1f2b]' : ''
              }`}
            >
              <div className="flex items-center justify-between text-[#94a3b8] text-[10px] mb-0.5">
                <span className="font-semibold text-[#00b4d8] flex items-center gap-1">
                  {log.kind === 'complete' ? (
                    <CheckCircle2 className="w-3 h-3 text-[#34d399]" />
                  ) : log.kind === 'event' ? (
                    <Terminal className="w-3 h-3 text-[#00b4d8]" />
                  ) : (
                    <ArrowRight className="w-3 h-3 text-[#fbbf24]" />
                  )}
                  {log.title}
                </span>
                <span>{log.timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </div>
              <p className="text-[#e2e8f0] break-words line-clamp-2">{log.detail}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
