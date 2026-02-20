import { describe, it, expect, beforeEach } from 'vitest';
import { AIBlock } from '../../../src/blocks/ai-block/index.js';

describe('AIBlock', () => {
  let block: AIBlock;

  beforeEach(() => {
    block = new AIBlock('test-ai');
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-ai');
      expect(block.type).toBe('ai');
    });

    it('should have all required capabilities', () => {
      const caps = block.capabilities;
      expect(caps.functions).toContain('request');
      expect(caps.functions).toContain('renderPrompt');
      expect(caps.functions).toContain('registerTemplate');
      expect(caps.functions).toContain('listTemplates');
    });
  });

  describe('execute - request', () => {
    it('should send AI request and return output', async () => {
      const result = await block.execute('request', {
        sdk: 'iflow',
        prompt: 'Test prompt',
        systemPrompt: 'You are helpful',
      });
      expect(result.output).toContain('iflow');
      expect(result.output).toContain('Test prompt');
      expect((result as any).sdk).toBe('iflow');
    });
  });

  describe('execute - registerTemplate', () => {
    it('should register a prompt template', async () => {
      const result = await block.execute('registerTemplate', {
        id: 'template-1',
        role: 'user',
        template: 'Hello {{name}}',
      });
      expect(result.registered).toBe(true);
    });
  });

  describe('execute - renderPrompt', () => {
    it('should render prompt with variables', async () => {
      await block.execute('registerTemplate', {
        id: 'template-1',
        role: 'user',
        template: 'Hello {{name}}, you are {{trait}}',
      });
      const result = await block.execute('renderPrompt', {
        templateId: 'template-1',
        variables: { name: 'Alice', trait: 'smart' },
      });
      expect((result as any).prompt).toBe('Hello Alice, you are smart');
    });

    it('should throw for non-existent template', async () => {
      await expect(block.execute('renderPrompt', {
        templateId: 'non-existent',
        variables: {},
      })).rejects.toThrow('not found');
    });
  });

  describe('execute - listTemplates', () => {
    it('should list all templates', async () => {
      await block.execute('registerTemplate', {
        id: 'template-1',
        role: 'user',
        template: 'Template 1',
      });
      await block.execute('registerTemplate', {
        id: 'template-2',
        role: 'assistant',
        template: 'Template 2',
      });
      const templates = await block.execute('listTemplates', {});
      expect(Array.isArray(templates)).toBe(true);
      expect(templates.length).toBe(2);
    });
  });

  describe('execute - unknown command', () => {
    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });
});
