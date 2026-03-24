import { describe, expect, it, vi } from 'vitest';
import { parseAgentDispatchToolInput } from '../../../src/server/modules/agent-runtime/parsers.js';

function createDeps(currentSessionId = 'session-current') {
  return {
    primaryOrchestratorAgentId: 'finger-system-agent',
    runtime: {
      getCurrentSession: vi.fn(() => ({ id: currentSessionId })),
    },
  };
}

describe('parseAgentDispatchToolInput', () => {
  it('uses current session by default when no session strategy is provided', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      target_agent_id: 'finger-project-agent',
      task: 'hello',
    }, deps as any);

    expect(result.sessionId).toBe('session-123');
    expect(result.sessionStrategy).toBeUndefined();
  });

  it('keeps session unresolved for latest strategy and preserves project path', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      target_agent_id: 'finger-project-agent',
      task: 'hello',
      session_strategy: 'latest',
      project_path: '/tmp/project-a',
    }, deps as any);

    expect(result.sessionId).toBeUndefined();
    expect(result.sessionStrategy).toBe('latest');
    expect(result.projectPath).toBe('/tmp/project-a');
  });

  it('explicit session id overrides strategy-driven auto resolution', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      target_agent_id: 'finger-project-agent',
      task: 'hello',
      session_strategy: 'new',
      session_id: 'explicit-session',
      cwd: '/tmp/project-b',
    }, deps as any);

    expect(result.sessionId).toBe('explicit-session');
    expect(result.sessionStrategy).toBe('new');
    expect(result.projectPath).toBe('/tmp/project-b');
  });
});

