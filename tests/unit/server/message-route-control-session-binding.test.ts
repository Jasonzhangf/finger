import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { registerMessageRoutes } from '../../../src/serverx/routes/message.impl.js';
import type { MessageRouteDeps } from '../../../src/server/routes/message-types.js';

vi.mock('../../../src/server/routes/message-route-execution.js', () => ({
  executeAsyncMessageRoute: vi.fn(async () => ({ statusCode: 200, payload: { ok: true } })),
  executeBlockingMessageRoute: vi.fn(async () => ({ statusCode: 200, payload: { ok: true } })),
}));

function createDeps(options?: { addMessageError?: Error }) {
  const runtime = {
    bindAgentSession: vi.fn(),
    setCurrentSession: vi.fn(),
    getBoundSessionId: vi.fn(() => null),
  } as unknown as MessageRouteDeps['runtime'];

  const sessionManager = {
    getSession: vi.fn((sessionId: string) => {
      if (sessionId === 'hb-session-1') {
        return {
          id: 'hb-session-1',
          projectPath: '/Users/fanzhang/.finger/system',
          context: {
            sessionTier: 'heartbeat-control',
            controlPath: 'heartbeat',
            controlSession: true,
            userInputAllowed: false,
          },
        };
      }
      if (sessionId === 'session-regular') {
        return {
          id: 'session-regular',
          projectPath: '/tmp/project',
          context: {
            sessionTier: 'business',
            controlPath: 'conversation',
            userInputAllowed: true,
          },
        };
      }
      return undefined;
    }),
    getCurrentSession: vi.fn(() => null),
    getOrCreateSystemSession: vi.fn(() => ({ id: 'system-main' })),
    updateContext: vi.fn(),
    addMessage: vi.fn(async () => {
      if (options?.addMessageError) throw options.addMessageError;
      return { id: 'm-user', role: 'user', content: 'tick', timestamp: new Date().toISOString() };
    }),
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
      resolveSessionWorkspaceDirsForMessage: vi.fn(() => ({
        rootDir: '/tmp',
        workspaceRootDir: '/tmp/workspace',
        memoryDir: '/tmp/sessions/hb-session-1/workspace/memory',
        deliverablesDir: '/tmp/workspace/deliverables',
        exchangeDir: '/tmp/workspace/exchange',
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

async function startServer(app: Express, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('message route control-session binding guard', () => {
  it('does not bind runtime session when inbound request targets heartbeat-control session', async () => {
    const { deps, runtime } = createDeps();
    const app = express();
    app.use(express.json());
    registerMessageRoutes(app, deps);

    const server = await startServer(app, 19995);
    const response = await fetch(`${server.url}/api/v1/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'finger-system-agent',
        sender: 'system-heartbeat',
        message: {
          sessionId: 'hb-session-1',
          content: 'heartbeat tick',
          metadata: {
            sessionId: 'hb-session-1',
            source: 'system-heartbeat',
            role: 'system',
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(runtime.bindAgentSession).not.toHaveBeenCalled();
    expect(runtime.setCurrentSession).not.toHaveBeenCalled();

    await server.close();
  });

  it('returns 500 and aborts dispatch when persisting inbound user message fails', async () => {
    const { deps } = createDeps({ addMessageError: new Error('disk write failed') });
    const app = express();
    app.use(express.json());
    registerMessageRoutes(app, deps);

    const server = await startServer(app, 19996);
    const response = await fetch(`${server.url}/api/v1/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'finger-project-agent',
        sender: 'webui',
        message: {
          sessionId: 'session-regular',
          content: 'run task',
          metadata: {
            sessionId: 'session-regular',
            role: 'user',
          },
        },
      }),
    });

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.code).toBe('PERSIST_USER_MESSAGE_FAILED');
    expect((deps.hub.sendToModule as any)).not.toHaveBeenCalled();

    await server.close();
  });
});
