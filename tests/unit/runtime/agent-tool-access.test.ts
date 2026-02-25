import { describe, expect, it } from 'vitest';
import { AgentToolAccessControl } from '../../../src/runtime/agent-tool-access.js';

describe('AgentToolAccessControl', () => {
  it('defaults to deny when whitelist is empty', () => {
    const access = new AgentToolAccessControl();
    const decision = access.canUse('agent-a', 'shell.exec');
    expect(decision.allowed).toBe(false);
  });

  it('allows tool after grant', () => {
    const access = new AgentToolAccessControl();
    access.grant('agent-a', 'shell.exec');
    const decision = access.canUse('agent-a', 'shell.exec');
    expect(decision.allowed).toBe(true);
  });

  it('blacklist has priority over whitelist', () => {
    const access = new AgentToolAccessControl();
    access.grant('agent-a', 'shell.exec');
    access.deny('agent-a', 'shell.exec');
    const decision = access.canUse('agent-a', 'shell.exec');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('blacklisted');
  });
});
