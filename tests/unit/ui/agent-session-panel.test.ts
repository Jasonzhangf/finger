import { describe, it, expect } from 'vitest';

// Simple validation test to avoid React dependency
// This test ensures AgentSessionPanel module exports are available

describe('AgentSessionPanel module', () => {
  it('should export AgentSessionPanel', async () => {
    const module = await import('../../../ui/src/components/AgentSessionPanel/AgentSessionPanel.js');
    expect(module.AgentSessionPanel).toBeDefined();
  });
});
