/**
 * Resource Pool Hook - 资源池状态管理
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './useWebSocket.js';

export interface ResourceInstance {
  id: string;
  config: {
    id?: string;
    name: string;
    mode: 'auto' | 'manual';
    provider: 'iflow' | 'openai' | 'anthropic';
    model?: string;
    systemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    permissionMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
    maxTurns?: number;
    maxIterations?: number;
    maxRounds?: number;
    enableReview?: boolean;
    cwd?: string;
    resumeSession?: boolean;
  };
  status: 'available' | 'deployed' | 'busy' | 'error';
  currentSessionId?: string;
  currentWorkflowId?: string;
  lastDeployedAt?: string;
  lastReleasedAt?: string;
  totalDeployments: number;
}

interface UseResourcePoolReturn {
  resources: ResourceInstance[];
  availableResources: ResourceInstance[];
  deployedResources: ResourceInstance[];
  isLoading: boolean;
  error: string | null;
  deployResource: (resourceId: string, sessionId: string, workflowId: string) => Promise<boolean>;
  releaseResource: (resourceId: string) => Promise<boolean>;
  refreshResources: () => Promise<void>;
}

export function useResourcePool(): UseResourcePoolReturn {
  const [resources, setResources] = useState<ResourceInstance[]>([]);
  const [isLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resourcesRef = useRef<ResourceInstance[]>([]);

  useEffect(() => {
    resourcesRef.current = resources;
  }, [resources]);

  const fetchResources = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/resources');
      if (!res.ok) throw new Error('Failed to fetch resources');
      const data = await res.json();
      const availableResources = data.available || [];
      const processedResources: ResourceInstance[] = availableResources.map((r: any) => ({
        ...r,
        config: r.config || {
          name: r.name || r.id || 'unnamed',
          mode: 'auto',
          provider: 'iflow'
        }
      }));
      setResources(processedResources);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  }, []);

  useEffect(() => {
    fetchResources();
    const interval = setInterval(fetchResources, 5000);
    return () => clearInterval(interval);
  }, [fetchResources]);

  const handleWebSocketMessage = useCallback((msg: { type: string; payload?: unknown }) => {
    if (msg.type === 'resource_update') {
      const payload = msg.payload as { resourceId: string; status: string; sessionId?: string; workflowId?: string };
      setResources((prev) =>
        prev.map((r) =>
          r.id === payload.resourceId
            ? {
                ...r,
                status: payload.status as ResourceInstance['status'],
                currentSessionId: payload.sessionId,
                currentWorkflowId: payload.workflowId,
              }
            : r
        )
      );
    }
  }, []);

  useWebSocket(handleWebSocketMessage);

  const deployResource = useCallback(async (resourceId: string, sessionId: string, workflowId: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/v1/resources/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId, sessionId, workflowId }),
      });
      if (!res.ok) throw new Error('Deploy failed');
      await fetchResources();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deploy failed');
      return false;
    }
  }, [fetchResources]);

  const releaseResource = useCallback(async (resourceId: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/v1/resources/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId }),
      });
      if (!res.ok) throw new Error('Release failed');
      await fetchResources();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Release failed');
      return false;
    }
  }, [fetchResources]);

  const availableResources = resources.filter((r) => r.status === 'available');
  const deployedResources = resources.filter((r) => r.status === 'deployed' || r.status === 'busy');

  return {
    resources,
    availableResources,
    deployedResources,
    isLoading,
    error,
    deployResource,
    releaseResource,
    refreshResources: fetchResources,
  };
}
