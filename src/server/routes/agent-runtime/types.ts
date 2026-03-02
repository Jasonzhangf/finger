import type { ModuleRegistry } from '../../../orchestration/module-registry.js';
import type { ResourcePool } from '../../../orchestration/resource-pool.js';
import type { AgentRuntimeDeps } from '../../modules/agent-runtime/types.js';

type MockOutcome = 'success' | 'failure';
type MockRole = 'executor' | 'reviewer' | 'searcher';

export interface AgentRuntimeRouteDeps {
  getAgentRuntimeDeps: () => AgentRuntimeDeps;
  moduleRegistry: ModuleRegistry;
  resourcePool: ResourcePool;
  runtimeDebug: {
    get: () => boolean;
    set: (enabled: boolean) => Promise<void>;
    moduleIds: readonly string[];
  };
  mockRuntime: {
    rolePolicy: Record<MockRole, MockOutcome>;
    clearAssertions: () => void;
    listAssertions: (filters: {
      agentId?: string;
      workflowId?: string;
      sessionId?: string;
      limit?: number;
    }) => unknown[];
  };
  flags: {
    enableFullMockMode: boolean;
    useMockExecutorLoop: boolean;
    useMockReviewerLoop: boolean;
    useMockSearcherLoop: boolean;
  };
}

export type AgentCapabilityLayer = 'summary' | 'execution' | 'governance' | 'full';

export function resolveAgentCapabilityLayer(value: unknown): AgentCapabilityLayer {
  if (typeof value !== 'string') return 'summary';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'execution') return 'execution';
  if (normalized === 'governance') return 'governance';
  if (normalized === 'full') return 'full';
  return 'summary';
}
