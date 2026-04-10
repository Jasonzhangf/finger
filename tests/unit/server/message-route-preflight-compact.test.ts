import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { registerMessageRoutes } from '../../../src/serverx/routes/message.impl.js';
import type { MessageRouteDeps } from '../../../src/server/routes/message-types.js';
import { executeBlockingMessageRoute } from '../../../src/server/routes/message-route-execution.js';

vi.mock('../../../src/server/routes/message-route-execution.js', () => ({
  executeAsyncMessageRoute: vi.fn(async () => ({ statusCode: 200, payload: { ok: true } })),
  executeBlockingMessageRoute: vi.fn(async () => ({ statusCode: 200, payload: { ok: true } })),
}));

function createDeps(sessionTotalTokens: number) {
  const runtime = {
    bindAgentSession: vi.fn(),
    setCurrentSession: vi.fn(),
    getBoundSessionId: vi.fn(() => null),
  } as unknown as MessageRouteDeps['runtime'];

  const session = {
    id: 'session-preflight-1',
    projectPath: '/tmp/project-preflight',
    totalTokens: sessionTotalTokens,
    latestCompactIndex: -1,
    messages: [
      {
        id: 'm-1',
        role: 'assistant',
        content: 'existing history',
        timestamp: new Date().toISOString(),
      },
    ],
    context: {},
  };

  const sessionManager = {
    getSession: vi.fn((sessionId: string) => (sessionId === session.id ? session : undefined)),
    getCurrentSession: vi.fn(() => session),
    getOrCreateSystemSession: vi.fn(() => ({ id: 'system-main' })),
    updateContext: vi.fn(),
    addMessage: vi.fn(async () => ({ id: 'm-user', role: 'user', content: 'run task', timestamp: new Date().toISOString() })),
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

  return { deps };
}

async function startServer(app: Express, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${resolvedPort}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('message route preflight compact', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('marks blocking request with compactManual before dispatch when session projection already exceeds threshold', async () => {
    const mockedExecuteBlockingMessageRoute = vi.mocked(executeBlockingMessageRoute);
    const { deps } = createDeps(300_000);
    const app = express();
    app.use(express.json());
    registerMessageRoutes(app, deps);

    const server = await startServer(app);
    try {
      const response = await fetch(`${server.url}/api/v1/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: 'finger-project-agent',
          sender: 'webui',
          blocking: true,
          message: {
            sessionId: 'session-preflight-1',
            content: 'run task after preflight compact',
            metadata: {
              sessionId: 'session-preflight-1',
              role: 'user',
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockedExecuteBlockingMessageRoute).toHaveBeenCalledTimes(1);
      const executionCall = mockedExecuteBlockingMessageRoute.mock.calls[0][0];
      const requestMessage = executionCall.requestMessage;
      expect(requestMessage.metadata.compactManual).toBe(true);
      expect(requestMessage.metadata.preflightCompact).toEqual(expect.objectContaining({
        trigger: 'session_projection_threshold',
        targetAgentId: executionCall.targetId,
        sessionTokens: 300_000,
      }));
    } finally {
      await server.close();
    }
  });

  it('does not mark compactManual when session projection is below threshold', async () => {
    const mockedExecuteBlockingMessageRoute = vi.mocked(executeBlockingMessageRoute);
    const { deps } = createDeps(1_000);
    const app = express();
    app.use(express.json());
    registerMessageRoutes(app, deps);

    const server = await startServer(app);
    try {
      const response = await fetch(`${server.url}/api/v1/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: 'finger-project-agent',
          sender: 'webui',
          blocking: true,
          message: {
            sessionId: 'session-preflight-1',
            content: 'small request',
            metadata: {
              sessionId: 'session-preflight-1',
              role: 'user',
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockedExecuteBlockingMessageRoute).toHaveBeenCalledTimes(1);
      const requestMessage = mockedExecuteBlockingMessageRoute.mock.calls[0][0].requestMessage;
      expect(requestMessage.metadata.compactManual).toBeUndefined();
      expect(requestMessage.metadata.preflightCompact).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
