import { describe, it, expect } from 'vitest';

describe('LeftSidebar module (system monitor wiring)', () => {
  it('should export LeftSidebar component', async () => {
    const module = await import('../../../ui/src/components/LeftSidebar/LeftSidebar.js');
    expect(module.LeftSidebar).toBeDefined();
  });
});
