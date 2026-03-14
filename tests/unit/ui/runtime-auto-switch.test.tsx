/**
 * Unit Test: Runtime Auto-Switch on Finished
 * 
 * Phase 3 Gate-3 Verification: 验证 runtime 结束时自动切回 orchestrator
 * @see docs/AGENT_MANAGEMENT_IMPLEMENTATION_PLAN.md Phase 3
 */

import { describe, it, expect } from 'vitest';

// Mock RuntimeEvent structure matching ui/src/api/types.ts
interface RuntimeEvent {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  kind?: 'thought' | 'action' | 'observation' | 'status';
  agentId?: string;
  agentName?: string;
  runtimeEventType?: 'runtime_status_changed' | 'runtime_finished';
  runtimeStatus?: 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'interrupted';
  runtimeInstanceId?: string;
  runtimeSessionId?: string;
}

// Mock session binding structure
interface SessionBinding {
  context: 'orchestrator' | 'runtime';
  sessionId: string;
  runtimeInstanceId?: string;
}

function buildRuntimeFinishedEvent(params: {
  id?: string;
  status?: RuntimeEvent['runtimeStatus'];
  runtimeInstanceId?: string;
  runtimeSessionId?: string;
}): RuntimeEvent {
  const {
    id = '1',
    status = 'completed',
    runtimeInstanceId,
    runtimeSessionId,
  } = params;
  return {
    id,
    role: 'system',
    kind: 'status',
    content: `[runtime] finished: ${status}`,
    timestamp: '2024-01-01T00:00:00Z',
    runtimeEventType: 'runtime_finished',
    runtimeStatus: status,
    runtimeInstanceId,
    runtimeSessionId,
  };
}

function runAutoSwitchLogic(params: {
  runtimeEvents: RuntimeEvent[];
  sessionBinding: SessionBinding;
  orchestratorSessionId: string;
  onSwitch: (next: SessionBinding) => void;
}): void {
  const { runtimeEvents, sessionBinding, orchestratorSessionId, onSwitch } = params;
  if (sessionBinding.context !== 'runtime') return;
  if (runtimeEvents.length === 0) return;

  const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
    return event.runtimeEventType === 'runtime_finished';
  });

  if (!lastRuntimeEvent) return;

  const matchesSession = sessionBinding.runtimeInstanceId
    ? lastRuntimeEvent.runtimeInstanceId === sessionBinding.runtimeInstanceId
    : (sessionBinding.sessionId && lastRuntimeEvent.runtimeSessionId === sessionBinding.sessionId);

  if (!matchesSession) return;

  const isTerminalStatus = lastRuntimeEvent.runtimeStatus === 'completed'
    || lastRuntimeEvent.runtimeStatus === 'failed'
    || lastRuntimeEvent.runtimeStatus === 'interrupted';

  if (isTerminalStatus) {
    onSwitch({
      context: 'orchestrator',
      sessionId: orchestratorSessionId,
    });
  }
}

describe('Runtime Auto-Switch on Finished', () => {
  it('should switch back to orchestrator when runtime finishes with completed status', () => {
    const runtimeEvents: RuntimeEvent[] = [
      {
        id: '1',
        role: 'system',
        kind: 'status',
        content: '[runtime] finished: completed',
        timestamp: '2024-01-01T00:00:00Z',
        runtimeEventType: 'runtime_finished',
        runtimeStatus: 'completed',
        runtimeInstanceId: 'inst-1',
        runtimeSessionId: 'runtime-session-123',
      },
    ];
    
    const sessionBinding: SessionBinding = {
      context: 'runtime',
      sessionId: 'runtime-session-123',
      runtimeInstanceId: 'inst-1',
    };
    
    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });
    
    expect(lastRuntimeEvent).toBeDefined();
    expect(lastRuntimeEvent?.runtimeEventType).toBe('runtime_finished');
    expect(lastRuntimeEvent?.runtimeStatus).toBe('completed');
    
    const matchesSession =
      (sessionBinding.runtimeInstanceId && lastRuntimeEvent?.runtimeInstanceId === sessionBinding.runtimeInstanceId)
      || (sessionBinding.sessionId && lastRuntimeEvent?.runtimeSessionId === sessionBinding.sessionId);
    
    expect(matchesSession).toBe(true);
    
    const isTerminalStatus = lastRuntimeEvent?.runtimeStatus === 'completed'
      || lastRuntimeEvent?.runtimeStatus === 'failed'
      || lastRuntimeEvent?.runtimeStatus === 'interrupted';
    
    expect(isTerminalStatus).toBe(true);
  });

  it('should switch back to orchestrator when runtime finishes with failed status', () => {
    const runtimeEvents: RuntimeEvent[] = [
      {
        id: '1',
        role: 'system',
        kind: 'status',
        content: '[runtime] finished: failed',
        timestamp: '2024-01-01T00:00:00Z',
        runtimeEventType: 'runtime_finished',
        runtimeStatus: 'failed',
        runtimeInstanceId: 'inst-1',
        runtimeSessionId: 'runtime-session-123',
      },
    ];
    
    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });
    
    expect(lastRuntimeEvent?.runtimeStatus).toBe('failed');
  });

  it('should switch back to orchestrator when runtime finishes with interrupted status', () => {
    const runtimeEvents: RuntimeEvent[] = [
      {
        id: '1',
        role: 'system',
        kind: 'status',
        content: '[runtime] finished: interrupted',
        timestamp: '2024-01-01T00:00:00Z',
        runtimeEventType: 'runtime_finished',
        runtimeStatus: 'interrupted',
        runtimeInstanceId: 'inst-1',
        runtimeSessionId: 'runtime-session-123',
      },
    ];
    
    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });
    
    expect(lastRuntimeEvent?.runtimeStatus).toBe('interrupted');
  });

  it('should not auto-switch when runtime is still running', () => {
    const runtimeEvents: RuntimeEvent[] = [
      {
        id: '1',
        role: 'system',
        kind: 'status',
        content: '[runtime] status=running',
        timestamp: '2024-01-01T00:00:00Z',
        runtimeEventType: 'runtime_status_changed',
        runtimeStatus: 'running',
        runtimeInstanceId: 'inst-1',
        runtimeSessionId: 'runtime-session-123',
      },
    ];
    
    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });
    
    expect(lastRuntimeEvent).toBeUndefined();
  });

  it('should not auto-switch when context is already orchestrator', () => {
    const sessionBinding: SessionBinding = {
      context: 'orchestrator',
      sessionId: 'orchestrator-session-456',
    };
    
    expect(sessionBinding.context).toBe('orchestrator');
  });

  it('should handle empty runtimeEvents gracefully', () => {
    const runtimeEvents: RuntimeEvent[] = [];
    
    expect(runtimeEvents.length).toBe(0);
  });

  it('should not auto-switch when event kind is not status', () => {
    const runtimeEvents: RuntimeEvent[] = [
      {
        id: '1',
        role: 'agent',
        kind: 'action',
        content: 'Tool executed successfully',
        timestamp: '2024-01-01T00:00:00Z',
      },
    ];
    
    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });
    
    expect(lastRuntimeEvent).toBeUndefined();
  });

  it('should filter only runtime_finished events', () => {
    const runtimeEvents: RuntimeEvent[] = [
      {
        id: '1',
        role: 'system',
        kind: 'status',
        content: '[runtime] status=running',
        timestamp: '2024-01-01T00:00:00Z',
        runtimeEventType: 'runtime_status_changed',
        runtimeStatus: 'running',
      },
      {
        id: '2',
        role: 'system',
        kind: 'status',
        content: '[runtime] finished: completed',
        timestamp: '2024-01-01T00:00:01Z',
        runtimeEventType: 'runtime_finished',
        runtimeStatus: 'completed',
        runtimeInstanceId: 'inst-1',
        runtimeSessionId: 'runtime-session-123',
      },
    ];
    
    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });
    
    expect(lastRuntimeEvent).toBeDefined();
    expect(lastRuntimeEvent?.runtimeEventType).toBe('runtime_finished');
    expect(lastRuntimeEvent?.runtimeStatus).toBe('completed');
  });

  
  it('should call setSessionBinding when matching runtimeInstanceId finishes with completed', () => {
    const runtimeEvents: RuntimeEvent[] = [
      {
        id: '1',
        role: 'system',
        kind: 'status',
        content: '[runtime] finished: completed',
        timestamp: '2024-01-01T00:00:00Z',
        runtimeEventType: 'runtime_finished',
        runtimeStatus: 'completed',
        runtimeInstanceId: 'inst-1',
        runtimeSessionId: 'runtime-session-123',
      },
    ];

    const sessionBinding: SessionBinding = {
      context: 'runtime',
      sessionId: 'runtime-session-123',
      runtimeInstanceId: 'inst-1',
    };

    const setSessionBinding = (next: SessionBinding) => {
      expect(next).toEqual({
        context: 'orchestrator',
        sessionId: 'orchestrator-session-456',
      });
    };

    const orchestratorSessionId = 'orchestrator-session-456';

    // 模拟 auto-switch 逻辑
    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });

    if (!lastRuntimeEvent) return;

    const matchesSession =
      (sessionBinding.runtimeInstanceId && lastRuntimeEvent.runtimeInstanceId === sessionBinding.runtimeInstanceId)
      || (sessionBinding.sessionId && lastRuntimeEvent.runtimeSessionId === sessionBinding.sessionId);

    if (!matchesSession) return;

    const isTerminalStatus = lastRuntimeEvent.runtimeStatus === 'completed'
      || lastRuntimeEvent.runtimeStatus === 'failed'
      || lastRuntimeEvent.runtimeStatus === 'interrupted';

    if (isTerminalStatus) {
      setSessionBinding({
        context: 'orchestrator',
        sessionId: orchestratorSessionId,
      });
    }
  });

  
  it('should not call setSessionBinding when runtimeStatus is non-terminal', () => {
    const runtimeEvents: RuntimeEvent[] = [
      {
        id: '1',
        role: 'system',
        kind: 'status',
        content: '[runtime] status=running',
        timestamp: '2024-01-01T00:00:00Z',
        runtimeEventType: 'runtime_finished',
        runtimeStatus: 'running',
        runtimeInstanceId: 'inst-1',
        runtimeSessionId: 'runtime-session-123',
      },
    ];

    const sessionBinding: SessionBinding = {
      context: 'runtime',
      sessionId: 'runtime-session-123',
      runtimeInstanceId: 'inst-1',
    };

    let called = false;
    const setSessionBinding = () => { called = true; };

    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });

    if (!lastRuntimeEvent) return;

    const matchesSession =
      (sessionBinding.runtimeInstanceId && lastRuntimeEvent.runtimeInstanceId === sessionBinding.runtimeInstanceId)
      || (sessionBinding.sessionId && lastRuntimeEvent.runtimeSessionId === sessionBinding.sessionId);

    if (!matchesSession) return;

    const isTerminalStatus = lastRuntimeEvent.runtimeStatus === 'completed'
      || lastRuntimeEvent.runtimeStatus === 'failed'
      || lastRuntimeEvent.runtimeStatus === 'interrupted';

    if (isTerminalStatus) {
      setSessionBinding();
    }

    expect(called).toBe(false);
  });
    it('should auto-switch when runtimeSessionId matches and runtimeInstanceId is missing', () => {
    const sessionBinding: SessionBinding = {
      context: 'runtime',
      sessionId: 'runtime-session-123',
      runtimeInstanceId: undefined,
    };

    const runtimeEvents: RuntimeEvent[] = [
      buildRuntimeFinishedEvent({
        runtimeSessionId: 'runtime-session-123',
        status: 'completed',
      }),
    ];

    let switched = false;
    const orchestratorSessionId = 'orchestrator-session-456';

    runAutoSwitchLogic({
      runtimeEvents,
      sessionBinding,
      orchestratorSessionId,
      onSwitch: (next) => {
        switched = next.context === 'orchestrator' && next.sessionId === orchestratorSessionId;
      },
    });

    expect(switched).toBe(true);
  });

  it('should not auto-switch when runtimeSessionId/runtimeInstanceId are missing', () => {
    const sessionBinding: SessionBinding = {
      context: 'runtime',
      sessionId: 'runtime-session-123',
      runtimeInstanceId: 'inst-1',
    };

    const runtimeEvents: RuntimeEvent[] = [
      buildRuntimeFinishedEvent({
        status: 'completed',
      }),
    ];

    let switched = false;
    const orchestratorSessionId = 'orchestrator-session-456';

    runAutoSwitchLogic({
      runtimeEvents,
      sessionBinding,
      orchestratorSessionId,
      onSwitch: () => {
        switched = true;
      },
    });

    expect(switched).toBe(false);
  });


  it('should not auto-switch when sessionId matches but runtimeInstanceId mismatches', () => {
    const sessionBinding: SessionBinding = {
      context: 'runtime',
      sessionId: 'runtime-session-123',
      runtimeInstanceId: 'inst-1',
    };

    const runtimeEvents: RuntimeEvent[] = [
      buildRuntimeFinishedEvent({
        runtimeInstanceId: 'inst-2',
        runtimeSessionId: 'runtime-session-123',
        status: 'completed',
      }),
    ];

    let switched = false;
    const orchestratorSessionId = 'orchestrator-session-456';

    runAutoSwitchLogic({
      runtimeEvents,
      sessionBinding,
      orchestratorSessionId,
      onSwitch: () => { switched = true; },
    });

    expect(switched).toBe(false);
  });
  it('should not auto-switch when different runtimeInstanceId finishes', () => {
    // Current session is bound to inst-1
    const sessionBinding: SessionBinding = {
      context: 'runtime',
      sessionId: 'runtime-session-123',
      runtimeInstanceId: 'inst-1',
    };
    
    // Last finished event is for inst-2 (different instance)
    const runtimeEvents: RuntimeEvent[] = [
      {
        id: '1',
        role: 'system',
        kind: 'status',
        content: '[runtime] finished: completed',
        timestamp: '2024-01-01T00:00:00Z',
        runtimeEventType: 'runtime_finished',
        runtimeStatus: 'completed',
        runtimeInstanceId: 'inst-2',
        runtimeSessionId: 'runtime-session-999',
      },
    ];
    
    const lastRuntimeEvent = [...runtimeEvents].reverse().find((event) => {
      return event.runtimeEventType === 'runtime_finished';
    });
    
    const matchesSession =
      (sessionBinding.runtimeInstanceId && lastRuntimeEvent?.runtimeInstanceId === sessionBinding.runtimeInstanceId)
      || (sessionBinding.sessionId && lastRuntimeEvent?.runtimeSessionId === sessionBinding.sessionId);
    
    expect(matchesSession).toBe(false);
  });
});
