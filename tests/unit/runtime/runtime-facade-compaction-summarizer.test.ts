import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/core/user-settings.js', () => ({
  loadContextBuilderSettings: vi.fn(() => ({
    rankingProviderId: '',
  })),
}));

vi.mock('../../../src/core/kernel-provider-client.js', () => ({
  resolveKernelProvider: vi.fn(() => ({ reason: 'provider_not_found' })),
  buildResponsesEndpoints: vi.fn(() => []),
  buildProviderHeaders: vi.fn(() => ({})),
}));

vi.mock('../../../src/runtime/context-ledger-memory.js', () => ({
  executeContextLedgerMemory: vi.fn(async () => ({
    ok: true,
    action: 'compact',
  })),
}));

import { RuntimeFacade, type ISessionManager, type SessionInfo } from '../../../src/runtime/runtime-facade.js';
import { loadContextBuilderSettings } from '../../../src/core/user-settings.js';
import {
  buildProviderHeaders,
  buildResponsesEndpoints,
  resolveKernelProvider,
} from '../../../src/core/kernel-provider-client.js';
import { executeContextLedgerMemory } from '../../../src/runtime/context-ledger-memory.js';

function createToolRegistryStub() {
  return {
    execute: vi.fn(async () => ({ ok: true })),
    getPolicy: vi.fn(() => 'allow'),
    register: vi.fn(),
    list: vi.fn(() => []),
    setPolicy: vi.fn(() => true),
    isAvailable: vi.fn(() => true),
  };
}

function createRuntimeWithSessionManager(sessionManager: ISessionManager): RuntimeFacade {
  const eventBus = {
    emit: vi.fn(async () => undefined),
    subscribe: vi.fn(),
    subscribeMultiple: vi.fn(),
    enablePersistence: vi.fn(),
  } as any;
  const toolRegistry = createToolRegistryStub() as any;
  return new RuntimeFacade(eventBus, sessionManager, toolRegistry);
}

function createSessionStub(sessionId = 'session-compact-1'): SessionInfo {
  return {
    id: sessionId,
    name: 'compact-session',
    projectPath: '/tmp/project',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 12,
    context: {
      ownerAgentId: 'finger-system-agent',
      sessionTier: 'main',
    },
  };
}

describe('RuntimeFacade compaction summarizer integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to session-manager default compression when no provider candidate exists', async () => {
    const session = createSessionStub('session-compact-fallback');
    const sessionManager: ISessionManager = {
      createSession: vi.fn(),
      getSession: vi.fn(() => session),
      getCurrentSession: vi.fn(() => null),
      setCurrentSession: vi.fn(() => true),
      listSessions: vi.fn(() => [session]),
      addMessage: vi.fn(async () => null),
      getMessages: vi.fn(() => []),
      deleteSession: vi.fn(() => true),
      compressContext: vi.fn(async (_sessionId: string, summarizer?: unknown) => {
        expect(summarizer).toBeUndefined();
        return 'fallback-summary';
      }),
      updateContext: vi.fn(() => true),
    };
    vi.mocked(loadContextBuilderSettings).mockReturnValue({
      rankingProviderId: '',
    });
    vi.mocked(resolveKernelProvider).mockReturnValue({
      reason: 'provider_not_found',
    });

    const runtime = createRuntimeWithSessionManager(sessionManager);
    const summary = await runtime.compressContext('session-compact-fallback', {
      trigger: 'manual',
    });

    expect(summary).toBe('fallback-summary');
    expect(sessionManager.compressContext).toHaveBeenCalledTimes(1);
  });

  it('uses model-based compaction summarizer for manual compaction when provider is available', async () => {
    const session = createSessionStub('session-compact-model');
    const modelSummary = [
      '1. **Primary Request and Intent**: request',
      '2. **Key Technical Concepts**: concept',
      '3. **Files and Code Sections**: file',
      '4. **Errors and Fixes**: none',
      '5. **Problem Solving**: steps',
      '6. **All User Messages**: user',
      '7. **Pending Tasks**: pending',
      '8. **Current Work**: work',
      '9. **Optional Next Step**: next',
    ].join('\n');
    const sessionManager: ISessionManager = {
      createSession: vi.fn(),
      getSession: vi.fn(() => session),
      getCurrentSession: vi.fn(() => null),
      setCurrentSession: vi.fn(() => true),
      listSessions: vi.fn(() => [session]),
      addMessage: vi.fn(async () => null),
      getMessages: vi.fn(() => [
        {
          id: 'm1',
          role: 'user',
          content: 'Implement compaction flow.',
          timestamp: new Date().toISOString(),
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Working on runtime changes.',
          timestamp: new Date().toISOString(),
        },
      ]),
      deleteSession: vi.fn(() => true),
      compressContext: vi.fn(async (_sessionId: string, summarizer?: unknown) => {
        expect(typeof summarizer).toBe('function');
        const summary = await (summarizer as (messages: Array<{ role: string; content: string }>) => Promise<string>)([
          { role: 'user', content: 'Implement compaction flow.' },
          { role: 'assistant', content: 'Working on runtime changes.' },
        ]);
        return summary;
      }),
      updateContext: vi.fn(() => true),
    };

    vi.mocked(loadContextBuilderSettings).mockReturnValue({
      rankingProviderId: 'ranker',
    });
    vi.mocked(resolveKernelProvider).mockImplementation((providerId?: string) => {
      if (providerId === 'ranker') {
        return {
          provider: {
            id: 'ranker',
            base_url: 'https://example.invalid/v1',
            wire_api: 'responses',
            env_key: 'TEST_KEY',
            model: 'ranker-model',
            enabled: true,
          },
        };
      }
      return {
        provider: {
          id: 'default',
          base_url: 'https://example.invalid/v1',
          wire_api: 'responses',
          env_key: 'TEST_KEY',
          model: 'default-model',
          enabled: true,
        },
      };
    });
    vi.mocked(buildResponsesEndpoints).mockReturnValue([
      'https://example.invalid/v1/responses',
    ]);
    vi.mocked(buildProviderHeaders).mockReturnValue({});

    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        output_text: `<analysis>ok</analysis>\n<summary>\n${modelSummary}\n</summary>`,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createRuntimeWithSessionManager(sessionManager);
    const summary = await runtime.compressContext('session-compact-model', {
      trigger: 'manual',
      contextUsagePercent: 92,
    });

    expect(summary).toContain('Primary Request and Intent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionManager.compressContext).toHaveBeenCalledTimes(1);
  });

  it('uses deterministic no-model summarizer for auto compaction even when provider is available', async () => {
    const session = createSessionStub('session-compact-auto-no-model');
    const sessionManager: ISessionManager = {
      createSession: vi.fn(),
      getSession: vi.fn(() => session),
      getCurrentSession: vi.fn(() => null),
      setCurrentSession: vi.fn(() => true),
      listSessions: vi.fn(() => [session]),
      addMessage: vi.fn(async () => null),
      getMessages: vi.fn(() => [
        {
          id: 'u1',
          role: 'user',
          content: 'compress automatically',
          timestamp: new Date().toISOString(),
        },
      ]),
      deleteSession: vi.fn(() => true),
      compressContext: vi.fn(async (_sessionId: string, summarizer?: unknown) => {
        expect(summarizer).toBeUndefined();
        return 'auto-fallback-summary';
      }),
      updateContext: vi.fn(() => true),
    };
    vi.mocked(loadContextBuilderSettings).mockReturnValue({
      rankingProviderId: 'ranker',
    });
    vi.mocked(resolveKernelProvider).mockImplementation((providerId?: string) => {
      if (providerId === 'ranker' || providerId === undefined) {
        return {
          provider: {
            id: 'ranker',
            base_url: 'https://example.invalid/v1',
            wire_api: 'responses',
            env_key: 'TEST_KEY',
            model: 'ranker-model',
            enabled: true,
          },
        };
      }
      return { reason: 'provider_not_found' };
    });
    vi.mocked(buildResponsesEndpoints).mockReturnValue(['https://example.invalid/v1/responses']);
    vi.mocked(buildProviderHeaders).mockReturnValue({});
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ output_text: 'should not be used' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createRuntimeWithSessionManager(sessionManager);
    const summary = await runtime.compressContext('session-compact-auto-no-model', {
      trigger: 'auto',
      contextUsagePercent: 91,
    });

    expect(summary).toBe('auto-fallback-summary');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionManager.compressContext).toHaveBeenCalledTimes(1);
  });

  it('preserves full key_tools list in replacement history (no truncation)', async () => {
    const session = createSessionStub('session-compact-tools');
    const toolNames = Array.from({ length: 16 }, (_, index) => `tool.${index + 1}`);
    const sessionMessages = [
      {
        id: 'u1',
        role: 'user',
        content: 'run many tools then compact',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      },
      ...toolNames.map((toolName, index) => ({
        id: `a-${index + 1}`,
        role: 'assistant',
        content: `done ${toolName}`,
        toolName,
        timestamp: new Date(Date.now() - 59_000 + index * 500).toISOString(),
      })),
    ];
    const sessionManager: ISessionManager = {
      createSession: vi.fn(),
      getSession: vi.fn(() => session),
      getCurrentSession: vi.fn(() => null),
      setCurrentSession: vi.fn(() => true),
      listSessions: vi.fn(() => [session]),
      addMessage: vi.fn(async () => null),
      getMessages: vi.fn(() => sessionMessages as unknown as ReturnType<ISessionManager['getMessages']>),
      deleteSession: vi.fn(() => true),
      compressContext: vi.fn(async () => 'fallback-summary'),
      updateContext: vi.fn(() => true),
    };
    vi.mocked(loadContextBuilderSettings).mockReturnValue({
      rankingProviderId: '',
    });
    vi.mocked(resolveKernelProvider).mockReturnValue({
      reason: 'provider_not_found',
    });

    const runtime = createRuntimeWithSessionManager(sessionManager);
    await runtime.compressContext('session-compact-tools', {
      trigger: 'manual',
    });

    const calls = vi.mocked(executeContextLedgerMemory).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const compactCall = calls
      .map((call) => call[0])
      .find((input) => input && typeof input === 'object' && (input as Record<string, unknown>).action === 'compact');
    expect(compactCall).toBeDefined();
    const replacementHistory = (compactCall as Record<string, unknown>).replacement_history as Array<Record<string, unknown>>;
    expect(Array.isArray(replacementHistory)).toBe(true);
    expect(replacementHistory.length).toBeGreaterThan(0);
    const first = replacementHistory[0] as { key_tools?: string[] };
    expect(Array.isArray(first.key_tools)).toBe(true);
    expect(first.key_tools?.length).toBe(toolNames.length);
    for (const toolName of toolNames) {
      expect(first.key_tools?.includes(toolName)).toBe(true);
    }
  });
});
