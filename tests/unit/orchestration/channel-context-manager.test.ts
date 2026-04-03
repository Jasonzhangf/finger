import { describe, it, expect } from 'vitest';
import { ChannelContextManager } from '../../../src/orchestration/channel-context-manager.js';

describe('ChannelContextManager', () => {
  it('returns default system agent for unknown channel', () => {
    const manager = new ChannelContextManager();
    manager.clearContext('unit-test-default');
    expect(manager.getTargetAgent('unit-test-default', { type: 'normal', targetAgent: '' })).toBe('finger-system-agent');
  });

  it('persists switched agent for channel routing', () => {
    const manager = new ChannelContextManager();
    manager.updateContext('unit-test-system', 'system', 'finger-system-agent');
    expect(manager.getTargetAgent('unit-test-system', { type: 'normal', targetAgent: '' })).toBe('finger-system-agent');
    manager.clearContext('unit-test-system');
  });

  it('prefers super command target over persisted context', () => {
    const manager = new ChannelContextManager();
    manager.updateContext('unit-test-override', 'system', 'finger-system-agent');
    expect(manager.getTargetAgent('unit-test-override', { type: 'super_command', targetAgent: 'finger-orchestrator' })).toBe('finger-orchestrator');
    manager.clearContext('unit-test-override');
  });
});
