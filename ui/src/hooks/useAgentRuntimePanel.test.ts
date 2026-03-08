import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAgentRuntimePanel } from './useAgentRuntimePanel.js';

vi.mock('./useWebSocket.js', () => ({
  useWebSocket: vi.fn(),
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useAgentRuntimePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes config-only agents in panel list', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/agents/runtime-view')) {
        return jsonResponse({
          agents: [
            {
              id: 'finger-orchestrator',
              name: 'Finger Orchestrator',
              type: 'orchestrator',
              status: 'running',
              source: 'deployment',
              instanceCount: 1,
              deployedCount: 1,
              availableCount: 0,
              runningCount: 1,
              queuedCount: 0,
              enabled: true,
              capabilities: [],
              defaultQuota: 1,
              quotaPolicy: { workflowQuota: {} },
              quota: { effective: 1, source: 'default' },
            },
          ],
          instances: [],
          configs: [
            {
              id: 'finger-orchestrator',
              name: 'Finger Orchestrator',
              role: 'orchestrator',
              filePath: '/tmp/orchestrator/agent.json',
              enabled: true,
              capabilities: ['dispatch'],
              defaultQuota: 1,
              quotaPolicy: { workflowQuota: {} },
            },
            {
              id: 'finger-executor',
              name: 'Finger Executor',
              role: 'executor',
              filePath: '/tmp/executor/agent.json',
              enabled: true,
              capabilities: ['execute'],
              defaultQuota: 2,
              quotaPolicy: { workflowQuota: {} },
            },
          ],
          startupTargets: [],
          startupTemplates: [],
        });
      }
      if (url.includes('/api/v1/agents/catalog')) {
        return jsonResponse({
          agents: [
            {
              id: 'finger-orchestrator',
              name: 'Finger Orchestrator',
              type: 'orchestrator',
              status: 'running',
              source: 'deployment',
              instanceCount: 1,
              deployedCount: 1,
              availableCount: 0,
              runningCount: 1,
              queuedCount: 0,
              enabled: true,
              runtimeCapabilities: ['dispatch'],
              defaultQuota: 1,
              quotaPolicy: { workflowQuota: {} },
              quota: { effective: 1, source: 'default' },
              capabilities: {
                summary: {
                  role: 'orchestrator',
                  source: 'deployment',
                  status: 'running',
                  tags: ['dispatch'],
                },
              },
            },
          ],
        });
      }
      if (url.includes('/api/v1/agents/debug/assertions')) {
        return jsonResponse({ assertions: [] });
      }
      if (url.includes('/api/v1/agents/debug/mode')) {
        return jsonResponse({ enabled: false });
      }
      if (url.includes('/api/v1/orchestration/config')) {
        return jsonResponse({
          config: {
            version: 1,
            activeProfileId: 'default',
            profiles: [
              {
                id: 'default',
                name: 'Default',
                agents: [
                  {
                    targetAgentId: 'finger-orchestrator',
                    role: 'orchestrator',
                    enabled: true,
                    visible: true,
                    instanceCount: 1,
                    launchMode: 'orchestrator',
                  },
                ],
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentRuntimePanel());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.configAgents.some((agent) => agent.id === 'finger-executor')).toBe(true);
    });

    const executor = result.current.configAgents.find((agent) => agent.id === 'finger-executor');
    expect(executor).toMatchObject({
      name: 'Finger Executor',
      type: 'executor',
      source: 'agent-json',
      status: 'idle',
      defaultQuota: 2,
    });
  });

  it('uses config enabled state as source of truth for static agent cards', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/agents/runtime-view')) {
        return jsonResponse({
          agents: [
            {
              id: 'finger-executor',
              name: 'Finger Executor',
              type: 'executor',
              status: 'idle',
              source: 'deployment',
              instanceCount: 1,
              deployedCount: 1,
              availableCount: 1,
              runningCount: 0,
              queuedCount: 0,
              enabled: true,
              capabilities: [],
              defaultQuota: 1,
              quotaPolicy: { workflowQuota: {} },
              quota: { effective: 1, source: 'default' },
            },
          ],
          instances: [],
          configs: [
            {
              id: 'finger-executor',
              name: 'Finger Executor',
              role: 'executor',
              filePath: '/tmp/executor/agent.json',
              enabled: false,
              capabilities: ['execute'],
              defaultQuota: 2,
              quotaPolicy: { workflowQuota: {} },
            },
          ],
          startupTargets: [],
          startupTemplates: [],
        });
      }
      if (url.includes('/api/v1/agents/catalog')) {
        return jsonResponse({ agents: [] });
      }
      if (url.includes('/api/v1/agents/debug/assertions')) {
        return jsonResponse({ assertions: [] });
      }
      if (url.includes('/api/v1/agents/debug/mode')) {
        return jsonResponse({ enabled: false });
      }
      if (url.includes('/api/v1/orchestration/config')) {
        return jsonResponse({
          config: {
            version: 1,
            activeProfileId: 'default',
            profiles: [],
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentRuntimePanel());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const executor = result.current.configAgents.find((agent) => agent.id === 'finger-executor');
    expect(executor).toMatchObject({
      enabled: false,
      source: 'agent-json',
      defaultQuota: 2,
    });
  });

  it('keeps disabled config-only agents visible after runtime undeploy', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/agents/runtime-view')) {
        return jsonResponse({
          agents: [],
          instances: [],
          configs: [
            {
              id: 'finger-reviewer',
              name: 'Finger Reviewer',
              role: 'reviewer',
              filePath: '/tmp/reviewer/agent.json',
              enabled: false,
              capabilities: ['review'],
              defaultQuota: 1,
              quotaPolicy: { workflowQuota: {} },
            },
          ],
          startupTargets: [],
          startupTemplates: [],
        });
      }
      if (url.includes('/api/v1/agents/catalog')) {
        return jsonResponse({ agents: [] });
      }
      if (url.includes('/api/v1/agents/debug/assertions')) {
        return jsonResponse({ assertions: [] });
      }
      if (url.includes('/api/v1/agents/debug/mode')) {
        return jsonResponse({ enabled: false });
      }
      if (url.includes('/api/v1/orchestration/config')) {
        return jsonResponse({
          config: {
            version: 1,
            activeProfileId: 'default',
            profiles: [],
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentRuntimePanel());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.configAgents).toHaveLength(1);
    expect(result.current.configAgents[0]).toMatchObject({
      id: 'finger-reviewer',
      enabled: false,
      source: 'agent-json',
      status: 'idle',
    });
  });
});
