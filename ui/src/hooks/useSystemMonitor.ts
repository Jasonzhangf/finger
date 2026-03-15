import { useCallback, useEffect, useMemo, useState } from 'react';
import { listSystemRegistry, setSystemMonitor } from '../api/client.js';
import type { SystemRegistryEntry } from '../api/types.js';

function normalizeProjectPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function useSystemMonitor() {
  const [entries, setEntries] = useState<SystemRegistryEntry[]>([]);

  const refresh = useCallback(async () => {
    const agents = await listSystemRegistry();
    setEntries(agents);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isEnabled = useCallback((projectPath: string) => {
    const normalized = normalizeProjectPath(projectPath);
    return entries.some((entry) => normalizeProjectPath(entry.projectPath) === normalized && entry.monitored);
  }, [entries]);

  const toggle = useCallback(async (projectPath: string, enabled: boolean) => {
    await setSystemMonitor(projectPath, enabled);
    await refresh();
  }, [refresh]);

  const selectedProjects = useMemo(() => {
    return entries
      .filter((entry) => entry.monitored)
      .map((entry) => entry.projectPath);
  }, [entries]);

  return {
    isEnabled,
    toggle,
    selectedProjects,
    entries,
    refresh,
  };
}
