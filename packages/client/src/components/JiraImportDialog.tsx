import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, Loader2, CheckCircle2, AlertCircle, Info, ShieldCheck } from 'lucide-react';
import type { JiraImportResult, Project } from '@/types';

interface JiraImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (projectId: string) => Promise<JiraImportResult | undefined>;
  projects: Project[];
  defaultProjectId: string;
}

export function JiraImportDialog({ open, onClose, onImport, projects, defaultProjectId }: JiraImportDialogProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<JiraImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState(defaultProjectId);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setResult(null);
      setError(null);
      setSelectedProjectId(defaultProjectId);
    }
  }, [open, defaultProjectId]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, loading, onClose]);

  const selectedProjectName = projects.find((p) => p.id === selectedProjectId)?.name ?? selectedProjectId;

  const handleImport = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await onImport(selectedProjectId);
      if (res) {
        setResult(res);
      } else {
        setError('Failed to import Jira issues. Please check server logs and configuration.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred during Jira import.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => {
            if (!loading) onClose();
          }}
        >
          <motion.div
            className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="jira-import-title"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  <Download className="h-4 w-4" />
                </div>
                <h2 id="jira-import-title" className="text-lg font-semibold text-foreground">
                  Import Assigned Jira Issues
                </h2>
              </div>
              <button
                onClick={onClose}
                disabled={loading}
                className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                aria-label="Close dialog"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 text-sm">
              <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 space-y-2 text-blue-300">
                <div className="flex items-start gap-2">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
                  <p className="text-xs leading-relaxed">
                    Import assigned issues from Jira into the <strong className="font-semibold text-blue-200">{selectedProjectName}</strong> project Backlog.
                  </p>
                </div>
                <div className="flex items-start gap-2 pt-1 border-t border-blue-500/20">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
                  <p className="text-xs text-blue-300/90 leading-relaxed">
                    Jira integration is <strong className="font-semibold text-blue-200">read-only</strong>. Board actions will never modify or mutate issues in Jira.
                  </p>
                </div>
              </div>

              {!result && (
                <div className="space-y-1">
                  <label htmlFor="jira-import-project" className="block text-xs font-medium text-muted-foreground">
                    Jira project
                  </label>
                  <select
                    id="jira-import-project"
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                    disabled={loading}
                    className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {result && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-emerald-400 font-medium">
                    <CheckCircle2 className="h-5 w-5 shrink-0" />
                    <span>Import Completed</span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2">
                      <span className="block text-muted-foreground">Total</span>
                      <span className="text-base font-bold text-foreground" data-testid="jira-import-total">{result.total}</span>
                    </div>
                    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2">
                      <span className="block text-emerald-400">Created</span>
                      <span className="text-base font-bold text-emerald-400" data-testid="jira-import-created">{result.created}</span>
                    </div>
                    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2">
                      <span className="block text-muted-foreground">Skipped</span>
                      <span className="text-base font-bold text-foreground" data-testid="jira-import-skipped">{result.skipped}</span>
                    </div>
                  </div>

                  {result.tasks.length > 0 && (
                    <div className="pt-2 border-t border-emerald-500/20 space-y-1">
                      <p className="text-xs font-medium text-emerald-300">Imported Issues:</p>
                      <ul className="max-h-28 overflow-y-auto space-y-1 text-xs text-muted-foreground">
                        {result.tasks.map((task) => (
                          <li key={task.id} className="truncate rounded bg-background/50 px-2 py-1 text-foreground" data-testid="imported-task-item">
                            {task.title}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 flex items-start gap-2 text-red-400 text-xs">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <div className="space-y-1">
                    <p className="font-semibold text-red-300">Import Failed</p>
                    <p className="leading-relaxed">{error}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
              <button
                onClick={onClose}
                disabled={loading}
                className="rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {result ? 'Close' : 'Cancel'}
              </button>
              {!result && (
                <button
                  onClick={handleImport}
                  disabled={loading}
                  data-testid="jira-import-submit"
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Importing…</span>
                    </>
                  ) : (
                    <>
                      <Download className="h-3.5 w-3.5" />
                      <span>Import Assigned Issues</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
