import { describe, it, expect } from 'vitest';
import { validateSystemCommand } from '../../../../src/server/middleware/system-auth.js';

describe('system-auth', () => {
  it('passes for non-system blocks', async () => {
    const result = await validateSystemCommand({ type: 'agent', content: 'continue' }, 'webui');
    expect(result.ok).toBe(true);
  });

  it('passes for whitelisted system channel by default', async () => {
    const result = await validateSystemCommand({ type: 'system', content: 'pwd' }, 'webui');
    expect(result.ok).toBe(true);
  });

  it('rejects non-whitelisted system channel', async () => {
    const result = await validateSystemCommand({ type: 'system', content: 'pwd' }, 'unknown-channel');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Channel not authorized');
    }
  });
});
