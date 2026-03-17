import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SystemAgentManager } from '../../../src/server/modules/system-agent-manager.js';
import type { AgentRuntimeDeps } from '../../../src/server/modules/agent-runtime/types.js';

describe('SystemAgentManager - Session Reuse', () => {
  let mockSessionManager: any;
  let mockAgentRuntimeBlock: any;
  let deps: AgentRuntimeDeps;

  beforeEach(() => {
    // Mock sessionManager
    mockSessionManager = {
      getOrCreateSystemSession: vi.fn(),
      ensureSession: vi.fn(),
    };

    // Mock agentRuntimeBlock
    mockAgentRuntimeBlock = {
      execute: vi.fn().mockResolvedValue({ ok: true, dispatchId: 'mock-dispatch-id' }),
    };

    deps = {
      sessionManager: mockSessionManager,
      agentRuntimeBlock: mockAgentRuntimeBlock,
    } as unknown as AgentRuntimeDeps;
  });

  it('should reuse existing system session when it exists', async () => {
    const existingSession = {
      id: 'existing-system-session-123',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-17T00:00:00Z',
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(existingSession);

    const manager = new SystemAgentManager(deps);
    await manager.start();

    // Verify getOrCreateSystemSession was called
    expect(mockSessionManager.getOrCreateSystemSession).toHaveBeenCalled();

    // Verify bootstrap injection uses the existing session ID
    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch'
    );
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall[1].sessionId).toBe(existingSession.id);
  });

  it('should create new session when no system session exists', async () => {
    const newSession = {
      id: 'new-system-session-456',
      name: 'System Agent Bootstrap',
      projectPath: '/tmp/system',
      createdAt: '2026-03-17T08:00:00Z',
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(newSession);

    const manager = new SystemAgentManager(deps);
    await manager.start();

    // Verify getOrCreateSystemSession was called
    expect(mockSessionManager.getOrCreateSystemSession).toHaveBeenCalled();

    // Verify bootstrap injection uses the new session ID
    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch'
    );
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall[1].sessionId).toBe(newSession.id);
  });

  it('should not create multiple sessions on restart', async () => {
    const existingSession = {
      id: 'reused-system-session-789',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-17T00:00:00Z',
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(existingSession);

    const manager1 = new SystemAgentManager(deps);
    await manager1.start();
    const firstCallCount = mockSessionManager.getOrCreateSystemSession.mock.calls.length;

    // Simulate restart: create new manager instance
    const manager2 = new SystemAgentManager(deps);
    await manager2.start();
    const secondCallCount = mockSessionManager.getOrCreateSystemSession.mock.calls.length;

    // getOrCreateSystemSession should be called exactly twice (once per manager)
    expect(secondCallCount).toBe(firstCallCount + 1);

    // Both should use the same session ID
    const dispatchCalls = mockAgentRuntimeBlock.execute.mock.calls.filter(
      (call: unknown[]) => call[0] === 'dispatch'
    );
    expect(dispatchCalls.length).toBe(2);
    expect(dispatchCalls[0][1].sessionId).toBe(existingSession.id);
    expect(dispatchCalls[1][1].sessionId).toBe(existingSession.id);
  });

  it('should handle session creation error gracefully', async () => {
    mockSessionManager.getOrCreateSystemSession.mockImplementation(() => {
      throw new Error('Failed to create session');
    });

    const manager = new SystemAgentManager(deps);
    await manager.start();

    // Should fall back to 'default' session ID
    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch'
    );
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall[1].sessionId).toBe('default');
  });
});
