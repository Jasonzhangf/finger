import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import type { MockRuntimeKit } from './mock-runtime.js';

export interface MockRuntimeSetupFlags {
  enableMockExecutor: boolean;
  enableMockReviewer: boolean;
  enableMockSearcher: boolean;
}

export interface MockRuntimeSetupResult {
  mockRolePolicy: MockRuntimeKit['mockRolePolicy'];
  debugRuntimeModuleIds: MockRuntimeKit['debugRuntimeModuleIds'];
  ensureDebugRuntimeModules: (enabled: boolean) => Promise<void>;
}

export async function registerMockRuntimeModules(params: {
  mockRuntimeKit: MockRuntimeKit;
  moduleRegistry: ModuleRegistry;
  flags: MockRuntimeSetupFlags;
}): Promise<MockRuntimeSetupResult> {
  const { mockRuntimeKit, moduleRegistry, flags } = params;
  const { createMockRuntimeRoleModule, ensureDebugRuntimeModules, mockRolePolicy, debugRuntimeModuleIds } = mockRuntimeKit;

  if (flags.enableMockExecutor) {
    const executorMock = createMockRuntimeRoleModule({
      id: 'executor-mock',
      name: 'Mock Executor',
      role: 'executor',
    });
    await moduleRegistry.register(executorMock);
    console.log('[Server] Mock Executor module registered: executor-mock');
  }

  if (flags.enableMockReviewer) {
    const reviewerMock = createMockRuntimeRoleModule({
      id: 'reviewer-mock',
      name: 'Mock Reviewer',
      role: 'reviewer',
    });
    await moduleRegistry.register(reviewerMock);
    console.log('[Server] Mock Reviewer module registered: reviewer-mock');
  }

  if (flags.enableMockSearcher) {
    const searcherMock = createMockRuntimeRoleModule({
      id: 'searcher-mock',
      name: 'Mock Searcher',
      role: 'searcher',
    });
    await moduleRegistry.register(searcherMock);
    console.log('[Server] Mock Searcher module registered: searcher-mock');
  }

  return {
    mockRolePolicy,
    debugRuntimeModuleIds,
    ensureDebugRuntimeModules: (enabled: boolean) => ensureDebugRuntimeModules(enabled, moduleRegistry),
  };
}
