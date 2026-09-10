import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Layers,
  Inbox,
  Play,
  CheckCircle2,
  Bot,
  Activity,
  Sun,
  Moon,
  FolderGit2,
  Wifi,
  WifiOff,
  ChevronDown,
} from 'lucide-react';
import type { Task, Project, AgentType } from '@/types';
import { useTasks } from '@/hooks/useTasks';
import { TaskQueuePanel } from './TaskQueuePanel';
import { TaskDetailPanel } from './TaskDetailPanel';
import { WorkerPresencePanel } from './WorkerPresencePanel';
import { CollaborationLogPanel } from './CollaborationLogPanel';
import { AssignWorkerModal } from './AssignWorkerModal';
import { TaskDialog } from '@/components/TaskDialog';
import { subscribeConnectionStatus, getConnectionStatus, type ConnectionStatus } from '@/lib/api';
import { slugify } from '@/lib/utils';

interface WorkerConsoleProps {
  project: Project;
  projects: Project[];
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  onBackToProjects: () => void;
  onSelectProject: (project: Project) => void;
  initialTaskId?: string;
}

export function WorkerConsole({
  project,
  projects,
  theme,
  toggleTheme,
  onBackToProjects,
  onSelectProject,
  initialTaskId,
}: WorkerConsoleProps) {
  const {
    tasks,
    addTask,
    updateTask,
    runTask,
    stopTask,
    resumeClarification,
    openOpenCodeSession,
    configureAndRunTask,
    createPR,
    mergeLocal,
    cleanupWorktree,
  } = useTasks(project.id);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialTaskId || null);
  const [activeView, setActiveView] = useState<'all' | 'executing' | 'backlog' | 'done'>('all');
  const [showRosterModal, setShowRosterModal] = useState(false);
  const [showLogFeed, setShowLogFeed] = useState(true);
  const [assigningTask, setAssigningTask] = useState<Task | null>(null);
  const [newTaskDialogOpen, setNewTaskDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(getConnectionStatus());
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);

  useEffect(() => {
    return subscribeConnectionStatus(setConnectionStatus);
  }, []);

  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null),
    [selectedTaskId, tasks]
  );

  const handleRunTaskWithConfig = useCallback(
    (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      if (task.repoPath) {
        const wantWorktree = task.useWorktree ?? false;
        configureAndRunTask(taskId, {
          repoPath: task.repoPath,
          branchName: wantWorktree
            ? task.branchName || `task/${slugify(task.title)}`
            : '',
          baseBranch: task.baseBranch || 'main',
          useWorktree: wantWorktree,
          agentType: task.agentType,
        });
      } else {
        runTask(taskId);
      }
    },
    [tasks, configureAndRunTask, runTask]
  );

  const handleAssignWorker = async (agentType: AgentType, runNow = false) => {
    if (!assigningTask) return;
    await updateTask(assigningTask.id, { agentType });
    if (runNow) {
      handleRunTaskWithConfig(assigningTask.id);
    }
  };

  const statusFilterForQueue = useMemo(() => {
    if (activeView === 'executing') return 'executing';
    if (activeView === 'backlog') return 'backlog';
    if (activeView === 'done') return 'done';
    return 'all';
  }, [activeView]);

  return (
    <div className="console-shell flex h-screen w-screen overflow-hidden bg-[#08090c] text-[#e2e8f0]">
      <aside className="w-[230px] shrink-0 bg-[#0e1015] border-r border-[#202532] flex flex-col justify-between select-none">
        <div>
          <div className="p-3 border-b border-[#202532]">
            <div className="relative">
              <button
                onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                className="w-full flex items-center justify-between p-2 rounded bg-[#14171e] border border-[#202532] hover:border-[#2c3343] transition-colors text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FolderGit2 className="w-4 h-4 text-[#00b4d8] shrink-0" />
                  <span className="font-semibold text-[12px] text-white truncate">
                    {project.name}
                  </span>
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-[#94a3b8] shrink-0" />
              </button>

              {projectDropdownOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 z-30 bg-[#14171e] border border-[#2c3343] rounded-md shadow-xl py-1">
                  <div className="px-2 py-1 text-[10px] uppercase font-semibold text-[#94a3b8]">
                    Switch Project
                  </div>
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        onSelectProject(p);
                        setProjectDropdownOpen(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-[12px] hover:bg-[#1b1f2b] transition-colors truncate ${
                        p.id === project.id ? 'text-[#00b4d8] font-semibold' : 'text-[#e2e8f0]'
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                  <div className="border-t border-[#202532] mt-1 pt-1">
                    <button
                      onClick={() => {
                        setProjectDropdownOpen(false);
                        onBackToProjects();
                      }}
                      className="w-full text-left px-3 py-1.5 text-[11px] text-[#94a3b8] hover:text-white hover:bg-[#1b1f2b] transition-colors"
                    >
                      Manage All Projects...
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="p-2 space-y-1">
            <div className="px-2 py-1 text-[10px] uppercase font-semibold text-[#94a3b8] tracking-[0.05em]">
              Saved Views
            </div>

            <button
              onClick={() => setActiveView('all')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[12px] font-medium transition-colors ${
                activeView === 'all'
                  ? 'bg-[rgba(0,180,216,0.12)] text-[#00b4d8] border border-[rgba(0,180,216,0.3)]'
                  : 'text-[#e2e8f0] hover:bg-[#1b1f2b]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Layers className="w-3.5 h-3.5" />
                <span>All Issues</span>
              </div>
              <span className="text-[10px] font-mono opacity-80">{tasks.length}</span>
            </button>

            <button
              onClick={() => setActiveView('executing')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[12px] font-medium transition-colors ${
                activeView === 'executing'
                  ? 'bg-[rgba(0,180,216,0.12)] text-[#00b4d8] border border-[rgba(0,180,216,0.3)]'
                  : 'text-[#e2e8f0] hover:bg-[#1b1f2b]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Play className="w-3.5 h-3.5 text-[#00b4d8]" />
                <span>Active / Executing</span>
              </div>
              <span className="text-[10px] font-mono opacity-80">
                {tasks.filter((t) => t.agentStatus === 'executing' || t.agentStatus === 'planning').length}
              </span>
            </button>

            <button
              onClick={() => setActiveView('backlog')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[12px] font-medium transition-colors ${
                activeView === 'backlog'
                  ? 'bg-[rgba(0,180,216,0.12)] text-[#00b4d8] border border-[rgba(0,180,216,0.3)]'
                  : 'text-[#e2e8f0] hover:bg-[#1b1f2b]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Inbox className="w-3.5 h-3.5 text-[#94a3b8]" />
                <span>Backlog</span>
              </div>
              <span className="text-[10px] font-mono opacity-80">
                {tasks.filter((t) => t.columnId === 'backlog').length}
              </span>
            </button>

            <button
              onClick={() => setActiveView('done')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[12px] font-medium transition-colors ${
                activeView === 'done'
                  ? 'bg-[rgba(0,180,216,0.12)] text-[#00b4d8] border border-[rgba(0,180,216,0.3)]'
                  : 'text-[#e2e8f0] hover:bg-[#1b1f2b]'
              }`}
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#34d399]" />
                <span>Done / Completed</span>
              </div>
              <span className="text-[10px] font-mono opacity-80">
                {tasks.filter((t) => t.columnId === 'done' || t.columnId === 'review').length}
              </span>
            </button>
          </div>

          <div className="p-2 border-t border-[#202532] mt-2 space-y-1">
            <div className="px-2 py-1 text-[10px] uppercase font-semibold text-[#94a3b8] tracking-[0.05em]">
              Agent Fleet
            </div>

            <button
              onClick={() => setShowRosterModal(true)}
              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[12px] font-medium text-[#e2e8f0] hover:bg-[#1b1f2b] transition-colors"
            >
              <div className="flex items-center gap-2">
                <Bot className="w-3.5 h-3.5 text-[#00b4d8]" />
                <span>Agent Roster</span>
              </div>
              <span className="w-2 h-2 rounded-full bg-[#34d399] shadow-[0_0_6px_#34d399]" />
            </button>

            <button
              onClick={() => setShowLogFeed(!showLogFeed)}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-[12px] font-medium transition-colors ${
                showLogFeed ? 'text-[#00b4d8] bg-[#14171e]' : 'text-[#e2e8f0] hover:bg-[#1b1f2b]'
              }`}
            >
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5" />
                <span>Event Stream</span>
              </div>
              <span className="text-[10px] font-mono text-[#94a3b8]">Live</span>
            </button>
          </div>
        </div>

        <div className="p-3 border-t border-[#202532] space-y-2">
          <div className="flex items-center justify-between text-[11px] text-[#94a3b8]">
            <div className="flex items-center gap-1.5">
              {connectionStatus === 'connected' ? (
                <Wifi className="w-3.5 h-3.5 text-[#34d399]" />
              ) : (
                <WifiOff className="w-3.5 h-3.5 text-red-400" />
              )}
              <span className="capitalize">{connectionStatus}</span>
            </div>

            <button
              onClick={toggleTheme}
              className="p-1 rounded hover:bg-[#1b1f2b] text-[#94a3b8] hover:text-white transition-colors"
              title="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex min-w-0 overflow-hidden">
        <TaskQueuePanel
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onSelectTask={(t) => setSelectedTaskId(t.id)}
          onRunTask={handleRunTaskWithConfig}
          onStopTask={stopTask}
          onNewTask={() => setNewTaskDialogOpen(true)}
          onAssignWorker={(t) => setAssigningTask(t)}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          statusFilter={statusFilterForQueue}
        />

        {selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            isOpen={!!selectedTask}
            onClose={() => setSelectedTaskId(null)}
            onRunTask={handleRunTaskWithConfig}
            onStopTask={stopTask}
            onOpenOpenCode={(t) => openOpenCodeSession(t.id)}
            onCreatePR={createPR}
            onMergeLocal={mergeLocal}
            onCleanupWorktree={cleanupWorktree}
            onUpdateTask={updateTask}
            onResumeClarification={resumeClarification}
            onOpenAssignModal={(t) => setAssigningTask(t)}
          />
        )}

        <CollaborationLogPanel
          isOpen={showLogFeed}
          onClose={() => setShowLogFeed(false)}
          onSelectTask={(id) => setSelectedTaskId(id)}
        />
      </main>

      {showRosterModal && (
        <WorkerPresencePanel
          isModal
          onClose={() => setShowRosterModal(false)}
        />
      )}

      <AssignWorkerModal
        task={assigningTask}
        isOpen={!!assigningTask}
        onClose={() => setAssigningTask(null)}
        onAssign={handleAssignWorker}
      />

      <TaskDialog
        open={newTaskDialogOpen}
        onClose={() => setNewTaskDialogOpen(false)}
        onSubmit={async (data) => {
          await addTask({ ...data, projectId: project.id, repoPath: project.repoPath || data.repoPath });
          setNewTaskDialogOpen(false);
        }}
        lockedRepoPath={project.repoPath}
        projectDefaults={{
          defaultAgentType: project.defaultAgentType,
          defaultPriority: project.defaultPriority,
          defaultBaseBranch: project.defaultBaseBranch,
          defaultUseWorktree: project.defaultUseWorktree,
        }}
      />
    </div>
  );
}
