import { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  Play,
  Square,
  Bot,
  Circle,
  CheckCircle2,
  Clock,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import type { Task, Priority, ColumnId, AgentStatus, AgentType } from '@/types';
import { PRIORITY_WEIGHT } from '@/lib/priority-config';

interface TaskQueuePanelProps {
  tasks: Task[];
  selectedTaskId?: string | null;
  onSelectTask: (task: Task) => void;
  onRunTask: (taskId: string) => void;
  onStopTask: (taskId: string) => void;
  onNewTask: () => void;
  onAssignWorker?: (task: Task) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  statusFilter?: string | null;
}

function getPriorityBadge(priority: Priority) {
  switch (priority) {
    case 'critical':
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/20 text-red-400 border border-red-500/30">CRITICAL</span>;
    case 'high':
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">HIGH</span>;
    case 'medium':
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-400 border border-blue-500/30">MED</span>;
    case 'low':
      return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-500/20 text-slate-400 border border-slate-500/30">LOW</span>;
  }
}

function getStatusIcon(status: AgentStatus, columnId: ColumnId) {
  if (status === 'executing' || status === 'planning') {
    return <span className="w-2.5 h-2.5 rounded-full bg-[#00b4d8] animate-pulse shadow-[0_0_8px_#00b4d8]" />;
  }
  if (status === 'awaiting_clarification') {
    return <HelpCircle className="w-3.5 h-3.5 text-amber-400 animate-bounce" />;
  }
  if (status === 'failed') {
    return <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
  }
  if (columnId === 'done' || status === 'complete') {
    return <CheckCircle2 className="w-3.5 h-3.5 text-[#34d399]" />;
  }
  if (columnId === 'in-progress' || columnId === 'pending') {
    return <Clock className="w-3.5 h-3.5 text-blue-400" />;
  }
  return <Circle className="w-3.5 h-3.5 text-[#94a3b8]" />;
}

function formatDuration(startedAt?: number, completedAt?: number) {
  if (!startedAt) return '-';
  const end = completedAt || Date.now();
  const seconds = Math.floor((end - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function TaskQueuePanel({
  tasks,
  selectedTaskId,
  onSelectTask,
  onRunTask,
  onStopTask,
  onNewTask,
  onAssignWorker,
  searchQuery,
  onSearchChange,
  statusFilter,
}: TaskQueuePanelProps) {
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all');
  const [agentFilter, setAgentFilter] = useState<AgentType | 'all'>('all');
  const [sortBy, setSortBy] = useState<'title' | 'priority' | 'created'>('priority');

  const filteredTasks = useMemo(() => {
    let list = tasks;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
    }

    if (statusFilter && statusFilter !== 'all') {
      if (statusFilter === 'executing') {
        list = list.filter((t) => t.agentStatus === 'executing' || t.agentStatus === 'planning' || t.agentStatus === 'awaiting_clarification');
      } else {
        list = list.filter((t) => t.columnId === statusFilter);
      }
    }

    if (priorityFilter !== 'all') {
      list = list.filter((t) => t.priority === priorityFilter);
    }

    if (agentFilter !== 'all') {
      list = list.filter((t) => t.agentType === agentFilter);
    }

    return [...list].sort((a, b) => {
      if (sortBy === 'priority') {
        // Lower weight = more urgent (critical is 0), so critical sorts first.
        return (PRIORITY_WEIGHT[a.priority] ?? 2) - (PRIORITY_WEIGHT[b.priority] ?? 2);
      }
      if (sortBy === 'created') {
        return b.createdAt - a.createdAt;
      }
      return a.title.localeCompare(b.title);
    });
  }, [tasks, searchQuery, statusFilter, priorityFilter, agentFilter, sortBy]);

  const groups = useMemo(() => {
    const active = filteredTasks.filter((t) => t.agentStatus === 'executing' || t.agentStatus === 'planning' || t.agentStatus === 'awaiting_clarification');
    const inProgress = filteredTasks.filter((t) => (t.columnId === 'in-progress' || t.columnId === 'pending') && !active.includes(t));
    const backlog = filteredTasks.filter((t) => t.columnId === 'backlog');
    const done = filteredTasks.filter((t) => t.columnId === 'review' || t.columnId === 'done');

    return [
      { id: 'active', title: 'Active & Executing', items: active },
      { id: 'in_progress', title: 'In Queue / Pending', items: inProgress },
      { id: 'backlog', title: 'Backlog', items: backlog },
      { id: 'done', title: 'Completed & Review', items: done },
    ].filter((g) => g.items.length > 0);
  }, [filteredTasks]);

  return (
    <div className="flex flex-col h-full bg-[#08090c] text-[#e2e8f0] flex-1 min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-[#0e1015] border-b border-[#202532]">
        <div className="flex items-center gap-2 flex-1 min-w-[200px] max-w-md bg-[#14171e] px-2.5 py-1.5 rounded-md border border-[#202532] focus-within:border-[#00b4d8]">
          <Search className="w-3.5 h-3.5 text-[#94a3b8] shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter tasks (press / to focus)..."
            className="w-full bg-transparent text-[12px] text-white focus:outline-none placeholder-[#94a3b8]"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as Priority | 'all')}
            className="bg-[#14171e] text-[#e2e8f0] border border-[#202532] rounded px-2 py-1 text-[11px] focus:outline-none focus:border-[#00b4d8]"
          >
            <option value="all">All Priorities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value as AgentType | 'all')}
            className="bg-[#14171e] text-[#e2e8f0] border border-[#202532] rounded px-2 py-1 text-[11px] focus:outline-none focus:border-[#00b4d8]"
          >
            <option value="all">All Workers</option>
              <option value="opencode">OpenCode</option>
          </select>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'title' | 'priority' | 'created')}
            className="bg-[#14171e] text-[#e2e8f0] border border-[#202532] rounded px-2 py-1 text-[11px] focus:outline-none focus:border-[#00b4d8]"
          >
            <option value="priority">Sort: Priority</option>
            <option value="created">Sort: Newest</option>
            <option value="title">Sort: Title</option>
          </select>

          <button
            onClick={onNewTask}
            className="flex items-center gap-1 px-3 py-1.5 rounded text-[12px] font-semibold bg-[#00b4d8] text-slate-950 hover:bg-[#38bdf8] transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Task
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {filteredTasks.length === 0 ? (
          <div className="text-center py-16 text-[#94a3b8] text-[12px]">
            No tasks match the selected filters.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.id} className="space-y-1">
              <div className="flex items-center gap-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[#94a3b8]">
                <span>{group.title}</span>
                <span className="px-1.5 py-0.2 rounded-full bg-[#14171e] border border-[#202532] text-[10px] text-white">
                  {group.items.length}
                </span>
              </div>

              <div className="space-y-1">
                {group.items.map((task) => {
                  const isSelected = selectedTaskId === task.id;
                  const isRunning = task.agentStatus === 'executing' || task.agentStatus === 'planning';

                  return (
                    <div
                      key={task.id}
                      onClick={() => onSelectTask(task)}
                      className={`group flex items-center gap-3 h-9 px-3 rounded-md border cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-[#12232f] border-[#00b4d8]'
                          : 'bg-[#0e1015] border-[#202532] hover:bg-[#1b1f2b] hover:border-[#2c3343]'
                      }`}
                    >
                      <div className="shrink-0 flex items-center justify-center w-4">
                        {getStatusIcon(task.agentStatus, task.columnId)}
                      </div>

                      <span className="font-mono text-[11px] text-[#00b4d8] shrink-0 font-semibold">
                        #{task.id.slice(0, 6)}
                      </span>

                      <span className="text-[12px] font-medium text-white truncate flex-1 min-w-0">
                        {task.title}
                      </span>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-[10px] text-[#94a3b8] bg-[#14171e] px-1.5 py-0.5 rounded border border-[#202532]">
                          {task.agentType || 'opencode'}
                        </span>

                        {task.labels && task.labels.length > 0 && task.labels.map((lbl) => (
                          <span key={lbl} className="px-1.5 py-0.5 rounded text-[10px] bg-[#00b4d8]/10 text-[#00b4d8] border border-[#00b4d8]/30 font-medium">
                            {lbl}
                          </span>
                        ))}

                        {getPriorityBadge(task.priority)}

                        <span className="font-mono text-[10px] text-[#94a3b8] w-12 text-right">
                          {formatDuration(task.startedAt, task.completedAt)}
                        </span>

                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {isRunning ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onStopTask(task.id);
                              }}
                              className="p-1 rounded text-red-400 hover:bg-red-500/20"
                              title="Stop Agent"
                            >
                              <Square className="w-3 h-3 fill-current" />
                            </button>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onRunTask(task.id);
                              }}
                              className="p-1 rounded text-[#00b4d8] hover:bg-[#00b4d8]/20"
                              title="Run Agent"
                            >
                              <Play className="w-3 h-3 fill-current" />
                            </button>
                          )}

                          {onAssignWorker && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onAssignWorker(task);
                              }}
                              className="p-1 rounded text-[#94a3b8] hover:text-white hover:bg-[#202532]"
                              title="Assign Worker"
                            >
                              <Bot className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
