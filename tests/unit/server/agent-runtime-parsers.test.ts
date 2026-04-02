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
  it('does not force current session by default (default strategy resolved later as latest)', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      target_agent_id: 'finger-project-agent',
      task: 'hello',
    }, deps as any);

    expect(result.sessionId).toBeUndefined();
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

  it('uses runtime current session only when session_strategy=current is explicit', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      target_agent_id: 'finger-project-agent',
      task: 'hello',
      session_strategy: 'current',
    }, deps as any);

    expect(result.sessionId).toBe('session-123');
    expect(result.sessionStrategy).toBe('current');
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

  it('parses assignment task contract fields for plan/review linkage', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      target_agent_id: 'finger-project-agent',
      task: 'implement context builder guard',
      assignment: {
        task_id: 'task-ctx-001',
        task_name: 'context-builder-guard',
        acceptance_criteria: 'No implicit history rebuild during continuation turns.',
        review_required: true,
        attempt: 2,
        phase: 'retry',
      },
    }, deps as any);

    expect(result.assignment).toEqual(expect.objectContaining({
      taskId: 'task-ctx-001',
      taskName: 'context-builder-guard',
      acceptanceCriteria: 'No implicit history rebuild during continuation turns.',
      reviewRequired: true,
      attempt: 2,
      phase: 'retry',
    }));
  });

  it('parses assignment.blocked_by into blockedBy array', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      target_agent_id: 'finger-project-agent',
      task: 'implement task',
      assignment: {
        task_id: 'task-123',
        blocked_by: ['dep-1', 'dep-2'],
      },
    }, deps as any);

    expect(result.assignment).toEqual(expect.objectContaining({
      taskId: 'task-123',
      blockedBy: ['dep-1', 'dep-2'],
    }));
  });

  it('parses assignment.depends_on alias into blockedBy array', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      target_agent_id: 'finger-project-agent',
      task: 'implement task',
      assignment: {
        task_id: 'task-124',
        depends_on: 'dep-a, dep-b',
      },
    }, deps as any);

    expect(result.assignment).toEqual(expect.objectContaining({
      taskId: 'task-124',
      blockedBy: ['dep-a', 'dep-b'],
    }));
  });

  it('keeps self-dispatch input parseable and defers guard to dispatch runtime', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      source_agent_id: 'finger-system-agent',
      target_agent_id: 'finger-system-agent',
      task: 'should fail',
    }, deps as any);
    expect(result.sourceAgentId).toBe('finger-system-agent');
    expect(result.targetAgentId).toBe('finger-system-agent');
  });

  it('normalizes legacy orchestrator gateway target to project agent id', () => {
    const deps = createDeps('session-123');
    const result = parseAgentDispatchToolInput({
      source_agent_id: 'finger-system-agent',
      target_agent_id: 'finger-orchestrator-gateway',
      task: 'run task',
    }, deps as any);

    expect(result.targetAgentId).toBe('finger-project-agent');
  });

  it('rejects unknown gateway target ids as non-dispatchable', () => {
    const deps = createDeps('session-123');
    expect(() => parseAgentDispatchToolInput({
      source_agent_id: 'finger-system-agent',
      target_agent_id: 'custom-gateway',
      task: 'run task',
    }, deps as any)).toThrow(/target_agent_id invalid/i);
  });
});
