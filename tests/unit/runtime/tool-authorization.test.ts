import { describe, expect, it } from 'vitest';
import { ToolAuthorizationManager } from '../../../src/runtime/tool-authorization.js';

describe('ToolAuthorizationManager', () => {
  it('issues token and consumes once', () => {
    const manager = new ToolAuthorizationManager();
    const grant = manager.issue('agent-1', 'shell.exec', 'tester', { ttlMs: 10000, maxUses: 1 });

    const first = manager.verifyAndConsume(grant.token, 'agent-1', 'shell.exec');
    expect(first.allowed).toBe(true);

    const second = manager.verifyAndConsume(grant.token, 'agent-1', 'shell.exec');
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain('not found');
  });

  it('rejects scope mismatch', () => {
    const manager = new ToolAuthorizationManager();
    const grant = manager.issue('agent-1', 'shell.exec', 'tester');
    const decision = manager.verifyAndConsume(grant.token, 'agent-2', 'shell.exec');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('scope mismatch');
  });
});
