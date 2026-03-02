import { describe, it, expect } from 'vitest';
import { AIBlock } from '../../src/blocks/ai-block/index.js';

describe('AIBlock', () => {
  it('renders prompt templates', async () => {
    const block = new AIBlock('ai-test');
    await block.execute('registerTemplate', {
      id: 'tmpl-1',
      role: 'system',
      template: 'Hello {{name}}'
    });

    const rendered = await block.execute('renderPrompt', { templateId: 'tmpl-1', variables: { name: 'World' } });
    expect(rendered).toEqual({ prompt: 'Hello World' });
  });

  it('returns placeholder request output and updates state', async () => {
    const block = new AIBlock('ai-test');
    const result = await block.execute('request', { sdk: 'codex', prompt: 'Ping', systemPrompt: 'SYS' });
    expect(result).toEqual({ output: '[codex] [SYS:SYS] Ping', sdk: 'codex' });
    expect(block.state.data?.requests).toBe(1);
  });

  it('throws when rendering missing template', async () => {
    const block = new AIBlock('ai-test');
    await expect(block.execute('renderPrompt', { templateId: 'missing', variables: {} })).rejects.toThrow(
      'Template missing not found'
    );
  });
});
