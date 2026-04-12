import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { registerMessageRoutes } from '../../../src/serverx/routes/message.impl.js';
import type { MessageRouteDeps } from '../../../src/server/routes/message-types.js';

vi.mock('../../../src/server/routes/message-route-execution.js', () => ({
  executeAsyncMessageRoute: vi.fn(async () => ({ statusCode: 200, payload: { ok: true } })),
  executeBlockingMessageRoute: vi.fn(async () => ({ statusCode: 200, payload: { ok: true } })),
}));

function createDeps() {
  const runtime = {
    bindAgentSession: vi.fn(),
    setCurrentSession: vi.fn(),
    getBoundSessionId: vi.fn(() => null),
  } as unknown as MessageRouteDeps['runtime'];

  const sessionsById: Record<string, { id: string; projectPath: string; context: Record<string, unknown> }> = {
    'session-a': { id: 'session-a', projectPath: '/tmp/project-a', context: {} },
    'session-b': { id: 'session-b', projectPath: '/tmp/project-b', context: {} },
  };

  const sessionManager = {
    getSession: vi.fn((sessionId: string) => sessionsById[sessionId]),
    getCurrentSession: vi.fn(() => null),
    getOrCreateSystemSession: vi.fn(() => ({ id: 'system-main' })),
    updateContext: vi.fn(),
    addMessage: vi.fn(async () => ({ id: 'm-user', role: 'user', content: 'task', timestamp: new Date().toISOString() })),
    setTransientLedgerMode: vi.fn(),
    clearTransientLedgerMode: vi.fn(),
  } as unknown as MessageRouteDeps['sessionManager'];

  const deps: MessageRouteDeps = {
    hub: { sendToModule: vi.fn(async () => ({ ok: true })) } as unknown as MessageRouteDeps['hub'],
    mailbox: {
      createMessage: vi.fn(() => 'msg-1'),
      updateStatus: vi.fn(),
    } as unknown as MessageRouteDeps['mailbox'],
    runtime,
    toolRegistry: {} as MessageRouteDeps['toolRegistry'],
    channelBridgeManager: {
      sendToChannel: vi.fn(async () => undefined),
    } as unknown as MessageRouteDeps['channelBridgeManager'],
    sessionManager,
    eventBus: {} as MessageRouteDeps['eventBus'],
    sessionWorkspaces: {
      resolveSessionWorkspaceDirsForMessage: vi.fn((sessionId: string) => ({
        rootDir: '/tmp',
        workspaceRootDir: `/tmp/workspace-${sessionId}`,
        memoryDir: `/tmp/sessions/${sessionId}/workspace/memory`,
        deliverablesDir: `/tmp/workspace-${sessionId}/deliverables`,
        exchangeDir: `/tmp/workspace-${sessionId}/exchange`,
      })),
    } as unknown as MessageRouteDeps['sessionWorkspaces'],
    broadcast: vi.fn(),
    writeMessageErrorSample: vi.fn(),
    blockingTimeoutMs: 100,
    blockingMaxRetries: 0,
    blockingRetryBaseMs: 1,
    allowDirectAgentRoute: true,
    primaryOrchestratorTarget: 'finger-system-agent',
    primaryOrchestratorAgentId: 'finger-system-agent',
    primaryOrchestratorGatewayId: 'finger-system-agent',
    legacyOrchestratorAgentId: 'finger-system-agent',
    legacyOrchestratorGatewayId: 'finger-system-agent',
  };

  return { deps, runtime };
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3, baseDelayMs = 100): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status !== 500 || attempt === retries - 1) {
        return response;
      }
    } catch (error: any) {
      if (attempt === retries - 1) throw error;
      // ECONNRESET or network errors → retry with exponential backoff
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 50;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('fetchWithRetry: unreachable');
}

async function startServer(app: Express, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${resolvedPort}`,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

describe('message route concurrent session binding', () => {
  it('binds each inbound request to its own session under parallel load', async () => {
    const { deps, runtime } = createDeps();
    const app = express();
    app.use(express.json());
    registerMessageRoutes(app, deps);

    const server = await startServer(app);
    try {
      // Small delay to ensure server is fully ready
      await new Promise((resolve) => setTimeout(resolve, 50));

      const requests = ['session-a', 'session-b'].map((sessionId) =>
        fetchWithRetry(`${server.url}/api/v1/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            target: 'finger-project-agent',
            sender: 'webui',
            message: {
              sessionId,
              content: `run ${sessionId}`,
              metadata: {
                sessionId,
                role: 'user',
              },
            },
          }),
        }),
      );
      const responses = await Promise.all(requests);
      expect(responses.every((response) => response.status === 200)).toBe(true);

      expect(runtime.bindAgentSession).toHaveBeenCalledTimes(2);
      const boundSessionIds = runtime.bindAgentSession.mock.calls.map((call) => call[1]);
      expect(boundSessionIds).toContain('session-a');
      expect(boundSessionIds).toContain('session-b');
      expect(runtime.setCurrentSession).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
