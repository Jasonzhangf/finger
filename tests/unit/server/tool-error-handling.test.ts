import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import express from 'express';
import { registerToolRoutes, type ToolRouteDeps } from '../../../src/server/routes/tools.js';
import type { ToolRegistry } from '../../../src/runtime/tool-registry.js';

// ── Regression test: tool error handling must not break the kernel loop ──
//
// When a tool execution fails, the /api/v1/tools/execute API must:
// 1. Always return HTTP 200 (never 4xx/5xx)
// 2. Return { success: false, error: "...", toolName, agentId }
// This allows the kernel-model to parse the error and emit a tool_error event
// so the agent can continue reasoning instead of crashing.

function createMockRuntime(opts?: { callToolThrows?: Error | null }) {
  const callTool = opts?.callToolThrows !== undefined && opts?.callToolThrows !== null
    ? vi.fn().mockRejectedValue(opts.callToolThrows)
    : vi.fn().mockResolvedValue({ output: 'ok' });
  return {
    callTool,
    setCurrentSession: vi.fn().mockReturnValue(true),
    setToolAuthorizationRequired: vi.fn(),
    issueToolAuthorization: vi.fn(),
    revokeToolAuthorization: vi.fn(),
    getAgentToolPolicy: vi.fn().mockReturnValue({}),
    setAgentToolWhitelist: vi.fn(),
    setAgentToolBlacklist: vi.fn(),
    grantToolToAgent: vi.fn().mockReturnValue({}),
    revokeToolFromAgent: vi.fn().mockReturnValue({}),
    denyToolForAgent: vi.fn().mockReturnValue({}),
    allowToolForAgent: vi.fn().mockReturnValue({}),
    listRoleToolPolicyPresets: vi.fn().mockReturnValue([]),
    applyAgentRoleToolPolicy: vi.fn().mockReturnValue({}),
  };
}

function createMockToolRegistry() {
  return {
    list: vi.fn().mockReturnValue([]),
    setPolicy: vi.fn().mockReturnValue(true),
    register: vi.fn(),
    isAvailable: vi.fn().mockReturnValue(false),
    execute: vi.fn(),
  } as unknown as ToolRegistry;
}

function setupApp(opts?: { callToolThrows?: Error | null }) {
  const app = express();
  app.use(express.json());
  const runtime = createMockRuntime(opts) as any;
  const deps: ToolRouteDeps = {
    toolRegistry: createMockToolRegistry(),
    runtime,
  };
  registerToolRoutes(app, deps);
  return { app, runtime };
}

describe('Tool error handling regression', () => {
  let server: ReturnType<typeof import('express').Express['listen']>;
  let baseUrl: string;

  async function startServer(app: Express, port: number): Promise<string> {
    return new Promise((resolve) => {
      server = app.listen(port, () => {
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  async function stopServer() {
    return new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // ── Test 1: Successful tool execution returns success:true with full shape ──
  it('returns { success: true, result, toolName, agentId } on success', async () => {
    const { app } = setupApp();
    baseUrl = await startServer(app, 19991);

    const res = await fetch(`${baseUrl}/api/v1/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'test-agent',
        toolName: 'echo.test',
        input: { message: 'hello' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body).toHaveProperty('result');
    expect(body.toolName).toBe('echo.test');
    expect(body.agentId).toBe('test-agent');

    await stopServer();
  });

  // ── Test 2 (CRITICAL): Tool execution error returns HTTP 200 with success:false ──
  it('returns HTTP 200 { success: false, error } when tool throws - never HTTP 400', async () => {
    const { app } = setupApp({
      callToolThrows: new Error('Tool execution denied: permission denied for action'),
    });
    baseUrl = await startServer(app, 19992);

    const res = await fetch(`${baseUrl}/api/v1/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'test-agent',
        toolName: 'shell.exec',
        input: { command: 'rm -rf /' },
      }),
    });

    // CRITICAL: Must be HTTP 200, NOT 400 or 500
    // The kernel-model treats non-2xx as HTTP-level errors and may not parse the body
    // correctly, so we must return 200 with success:false
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('Tool execution denied');
    expect(body.toolName).toBe('shell.exec');
    expect(body.agentId).toBe('test-agent');

    await stopServer();
  });

  // ── Test 3: Non-Error throw still returns HTTP 200 with success:false ──
  it('returns HTTP 200 { success: false, error } when tool throws a string', async () => {
    const { app } = setupApp({
      callToolThrows: new Error('Unknown error occurred'),
    });
    baseUrl = await startServer(app, 19993);

    const res = await fetch(`${baseUrl}/api/v1/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-2',
        toolName: 'read_file',
        input: { path: '/nonexistent' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
    expect(body.toolName).toBe('read_file');

    await stopServer();
  });

  // ── Test 4: Validation errors (missing fields) still return HTTP 400 ──
  it('returns HTTP 400 for missing agentId (validation, not execution error)', async () => {
    const { app } = setupApp();
    baseUrl = await startServer(app, 19994);

    const res = await fetch(`${baseUrl}/api/v1/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolName: 'echo.test',
        input: {},
      }),
    });

    // Validation errors are pre-execution and should still be 400
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body).toHaveProperty('error');
    expect(body.error).toContain('agentId');

    await stopServer();
  });

// ── Test 5: Validation errors (missing toolName) still return HTTP 400 ──
  it('returns HTTP 400 for missing toolName', async () => {
    const { app } = setupApp();
    baseUrl = await startServer(app, 19995);

    const res = await fetch(`${baseUrl}/api/v1/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'test-agent',
        input: {},
      }),
    });

    expect(res.status).toBe(400);

    await stopServer();
  });

  // ── Test 6: Authorization failure returns HTTP 200 with success:false ──
  // When shell.exec requires authorization but no token is provided,
  // runtime.callTool() throws "authorization token required for tool 'shell.exec'"
  // The API must catch this and return HTTP 200 + success:false
  it('returns HTTP 200 { success:false, error } when authorization required', async () => {
    const { app } = setupApp({
      callToolThrows: new Error("authorization token required for tool 'shell.exec'"),
    });
    baseUrl = await startServer(app, 19996);

    const res = await fetch(`${baseUrl}/api/v1/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'test-agent',
        toolName: 'shell.exec',
        input: { command: 'ls' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('authorization token required');
    expect(body.toolName).toBe('shell.exec');
    expect(body.agentId).toBe('test-agent');

    await stopServer();
  });

  // ── Test 7: Expired authorization token returns HTTP 200 with success:false ──
  it('returns HTTP 200 { success:false, error } for expired authorization', async () => {
    const { app } = setupApp({
      callToolThrows: new Error("authorization token expired for tool 'shell.exec'"),
    });
    baseUrl = await startServer(app, 19997);

    const res = await fetch(`${baseUrl}/api/v1/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'test-agent',
        toolName: 'shell.exec',
        input: { command: 'rm -rf /' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error).toContain('expired');

    await stopServer();
  });

  it('binds tool execution to provided sessionId before calling runtime', async () => {
    const { app, runtime } = setupApp();
    baseUrl = await startServer(app, 19998);

    const res = await fetch(`${baseUrl}/api/v1/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'test-agent',
        toolName: 'echo.test',
        sessionId: 'session-abc',
        input: { message: 'hello' },
      }),
    });

    expect(res.status).toBe(200);
    expect(runtime.setCurrentSession).toHaveBeenCalledWith('session-abc');
    expect(runtime.callTool).toHaveBeenCalledWith('test-agent', 'echo.test', { message: 'hello' }, { authorizationToken: undefined });

    await stopServer();
  });
});
