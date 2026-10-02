import { useEffect, useState } from 'react';
import { api, type TaskGroupWithChildren } from '@/lib/api';
import { MAX_GROUP_CHILDREN } from '@/types';

/**
 * Groups an approved work request may be placed into: same project, not
 * archived, not started (backlog), and with room for another child. Mirrors
 * the server-side rules of the approval endpoint.
 */
export function useWorkRequestGroups(projectId: string | undefined, enabled: boolean): TaskGroupWithChildren[] {
  const [groups, setGroups] = useState<TaskGroupWithChildren[]>([]);

  useEffect(() => {
    if (!enabled || !projectId) {
      setGroups([]);
      return;
    }
    let cancelled = false;
    api.getGroups(false, projectId)
      .then((all) => {
        if (cancelled) return;
        setGroups(all.filter((group) => !group.archived
          && group.columnId === 'backlog'
          && group.children.length < MAX_GROUP_CHILDREN));
      })
      .catch((error: unknown) => {
        if (!cancelled) setGroups([]);
        console.error('Failed to load groups for work requests:', error);
      });
    return () => { cancelled = true; };
  }, [projectId, enabled]);

  return groups;
}
