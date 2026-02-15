import { useState, useEffect, useCallback } from 'react';
import { listModules } from '../api/client.js';
import type { ModuleInfo } from '../api/types.js';

interface AgentNode extends ModuleInfo {
  status: 'idle' | 'running' | 'error';
  load: number;
  requestCount: number;
  errorRate: number;
}

interface UseAgentsReturn {
  agents: AgentNode[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAgents(): UseAgentsReturn {
  const [agents, setAgents] = useState<AgentNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await listModules();
      // Transform modules to agents
      const agentList: AgentNode[] = data.modules
        .filter((m) => m.type === 'output' || m.type === 'agent')
        .map((m) => ({
          ...m,
          status: 'idle' as const,
          load: 0,
          requestCount: 0,
          errorRate: 0,
        }));
      setAgents(agentList);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agents');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    agents,
    isLoading,
    error,
    refresh,
  };
}

export type { AgentNode };
