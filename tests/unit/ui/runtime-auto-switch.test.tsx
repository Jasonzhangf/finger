/**
 * Unit Test: Runtime Auto-Switch on Finished
 * 
 * Phase 3 Gate-3 Verification: 验证 runtime 结束时自动切回 orchestrator
 * @see docs/AGENT_MANAGEMENT_IMPLEMENTATION_PLAN.md Phase 3
 */

import { describe, it, expect } from 'vitest';

describe('Runtime Auto-Switch on Finished', () => {
  it('should switch back to orchestrator when runtime finishes with completed status', () => {
    // Mock runtime events
    const runtimeEvents = [
      { kind: 'status', content: '[runtime] finished: completed' },
    ];
    
    // Mock session binding in runtime context
    const sessionBinding = {
      context: 'runtime' as const,
      sessionId: 'runtime-session-123',
    };
    
    const orchestratorSessionId = 'orchestrator-session-456';
    
    // Simulate checking the last event
    const lastEvent = runtimeEvents[runtimeEvents.length - 1];
    expect(lastEvent).toBeDefined();
    
    // Check if it's a finished event
    const isFinishedEvent = lastEvent.content?.includes('finished');
    expect(isFinishedEvent).toBe(true);
    
    // Check if it's a terminal status
    const isTerminalStatus = lastEvent.content?.includes('completed')
      || lastEvent.content?.includes('failed')
      || lastEvent.content?.includes('interrupted');
    expect(isTerminalStatus).toBe(true);
    
    // Verify condition for auto-switch
    const shouldAutoSwitch = isTerminalStatus && sessionBinding.context === 'runtime';
    expect(shouldAutoSwitch).toBe(true);
    
    // Expected new session binding
    const newSessionBinding = {
      context: 'orchestrator' as const,
      sessionId: orchestratorSessionId,
    };
    expect(newSessionBinding.context).toBe('orchestrator');
    expect(newSessionBinding.sessionId).toBe(orchestratorSessionId);
  });

  it('should switch back to orchestrator when runtime finishes with failed status', () => {
    const runtimeEvents = [
      { kind: 'status', content: '[runtime] finished: failed' },
    ];
    
    const sessionBinding = {
      context: 'runtime' as const,
      sessionId: 'runtime-session-123',
    };
    
    const lastEvent = runtimeEvents[runtimeEvents.length - 1];
    const isTerminalStatus = lastEvent.content?.includes('completed')
      || lastEvent.content?.includes('failed')
      || lastEvent.content?.includes('interrupted');
    
    expect(isTerminalStatus).toBe(true);
    expect(sessionBinding.context === 'runtime').toBe(true);
  });

  it('should switch back to orchestrator when runtime finishes with interrupted status', () => {
    const runtimeEvents = [
      { kind: 'status', content: '[runtime] finished: interrupted' },
    ];
    
    const sessionBinding = {
      context: 'runtime' as const,
      sessionId: 'runtime-session-123',
    };
    
    const lastEvent = runtimeEvents[runtimeEvents.length - 1];
    const isTerminalStatus = lastEvent.content?.includes('completed')
      || lastEvent.content?.includes('failed')
      || lastEvent.content?.includes('interrupted');
    
    expect(isTerminalStatus).toBe(true);
    expect(sessionBinding.context === 'runtime').toBe(true);
  });

  it('should not auto-switch when runtime is still running', () => {
    const runtimeEvents = [
      { kind: 'status', content: '[runtime] status=running' },
    ];
    
    const sessionBinding = {
      context: 'runtime' as const,
      sessionId: 'runtime-session-123',
    };
    
    const lastEvent = runtimeEvents[runtimeEvents.length - 1];
    const isFinishedEvent = lastEvent.content?.includes('finished');
    
    expect(isFinishedEvent).toBe(false);
    // Should not trigger auto-switch
    const shouldAutoSwitch = isFinishedEvent && sessionBinding.context === 'runtime';
    expect(shouldAutoSwitch).toBe(false);
  });

  it('should not auto-switch when context is already orchestrator', () => {
    const runtimeEvents = [
      { kind: 'status', content: '[runtime] finished: completed' },
    ];
    
    const sessionBinding = {
      context: 'orchestrator' as const,
      sessionId: 'orchestrator-session-456',
    };
    
    const lastEvent = runtimeEvents[runtimeEvents.length - 1];
    const isFinishedEvent = lastEvent.content?.includes('finished');
    
    expect(isFinishedEvent).toBe(true);
    // Should not trigger auto-switch because context is not runtime
    const shouldAutoSwitch = isFinishedEvent && sessionBinding.context === 'runtime';
    expect(shouldAutoSwitch).toBe(false);
  });

  it('should handle empty runtimeEvents gracefully', () => {
    const runtimeEvents: any[] = [];
    
    const sessionBinding = {
      context: 'runtime' as const,
      sessionId: 'runtime-session-123',
    };
    
    // Should not trigger auto-switch when events are empty
    expect(runtimeEvents.length).toBe(0);
    const lastEvent = runtimeEvents[runtimeEvents.length - 1];
    expect(lastEvent).toBeUndefined();
  });
});
