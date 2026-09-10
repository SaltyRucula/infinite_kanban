import { useState, useCallback, useEffect } from 'react';
import type { Worker } from '@/types';
import { api, connectWS } from '@/lib/api';

export function useWorkers() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkers = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getWorkers();
      setWorkers(data);
    } catch (err) {
      setError(`Failed to load workers: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch workers on mount
  useEffect(() => {
    void fetchWorkers();
  }, [fetchWorkers]);

  // WebSocket: live worker updates and re-sync on reconnect
  useEffect(() => {
    return connectWS(
      (msg) => {
        if (msg.type === 'worker_updated') {
          const worker = msg.payload;
          setWorkers((prev) => {
            const exists = prev.some((w) => w.id === worker.id);
            if (exists) {
              return prev.map((w) => (w.id === worker.id ? worker : w));
            }
            return [...prev, worker];
          });
        }
        if (msg.type === 'worker_removed') {
          const { id } = msg.payload;
          setWorkers((prev) => prev.filter((w) => w.id !== id));
        }
      },
      () => {
        void fetchWorkers();
      },
    );
  }, [fetchWorkers]);

  return {
    workers,
    loading,
    error,
    refetch: fetchWorkers,
  };
}
