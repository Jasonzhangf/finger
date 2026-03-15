import { describe, it, expect, beforeEach } from 'vitest';
import { IngressClassifier, ingressClassifier, type IngressMessage, type ClassifiedMessage } from '../../../src/orchestration/openclaw-ingress-classifier.js';

describe('IngressClassifier', () => {
  let classifier: IngressClassifier;

  beforeEach(() => {
    classifier = new IngressClassifier();
  });

  describe('classify - command detection', () => {
    it('should classify explicit command', () => {
      const message: IngressMessage = {
        id: 'msg-1',
        source: 'discord',
        content: '/status',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const result = classifier.classify(message);

      expect(result.category).toBe('command');
      expect(result.confidence).toBe(0.9);
      expect(result.extractedData.command).toBe('status');
      expect(result.extractedData.arguments).toEqual({});
      expect(result.suggestedAction).toBe('route_to_agent');
    });

    it('should classify command with arguments', () => {
      const message: IngressMessage = {
        id: 'msg-1',
        source: 'discord',
        content: '/deploy env=production',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const result = classifier.classify(message);

      expect(result.category).toBe('command');
      expect(result.extractedData.command).toBe('deploy');
      expect(result.extractedData.arguments).toEqual({ env: 'production' });
    });

    it('should classify command with hyphen', () => {
      const message: IngressMessage = {
        id: 'msg-1',
        source: 'discord',
        content: '/create-task',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const result = classifier.classify(message);

      expect(result.category).toBe('command');
      expect(result.extractedData.command).toBe('create-task');
    });
  });

  describe('classify - task detection', () => {
    it('should classify task-related message', () => {
      const message: IngressMessage = {
        id: 'msg-1',
        source: 'slack',
        content: 'Please create a new task for the UI redesign',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const result = classifier.classify(message);

      expect(result.category).toBe('task');
      expect(result.confidence).toBe(0.7);
      expect(result.suggestedAction).toBe('route_to_orchestrator');
    });
  });

  describe('classify - question detection', () => {
    it('should classify question with question mark', () => {
      const message: IngressMessage = {
        id: 'msg-1',
        source: 'discord',
        content: 'How do I use the OpenClaw plugin?',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const result = classifier.classify(message);

      expect(result.category).toBe('question');
      expect(result.confidence).toBe(0.6);
      expect(result.suggestedAction).toBe('route_to_agent');
    });
  });

  describe('classify - notification detection', () => {
    it('should classify message with mentions', () => {
      const message: IngressMessage = {
        id: 'msg-1',
        source: 'discord',
        content: '@John please review this PR',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const result = classifier.classify(message);

      expect(result.category).toBe('notification');
      expect(result.confidence).toBe(0.8);
      expect(result.extractedData.mentions).toContain('John');
      expect(result.suggestedAction).toBe('store_in_mailbox');
    });
  });

  describe('classify - conversation default', () => {
    it('should classify non-matching as conversation', () => {
      const message: IngressMessage = {
        id: 'msg-1',
        source: 'discord',
        content: 'Hello! Great to see you today',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const result = classifier.classify(message);

      expect(result.category).toBe('conversation');
      expect(result.confidence).toBe(0.5);
      expect(result.suggestedAction).toBe('route_to_agent');
    });
  });

  describe('classifyBatch', () => {
    it('should classify multiple messages', () => {
      const messages: IngressMessage[] = [
        {
          id: 'msg-1',
          source: 'discord',
          content: '/status',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: 'msg-2',
          source: 'slack',
          content: 'What is the progress?',
          timestamp: '2024-01-01T00:00:00Z',
        },
        {
          id: 'msg-3',
          source: 'discord',
          content: '@John please review',
          timestamp: '2024-01-01T00:00:00Z',
        },
      ];

      const results = classifier.classifyBatch(messages);

      expect(results).toHaveLength(3);
      expect(results[0].category).toBe('command');
      expect(results[1].category).toBe('question');
      expect(results[2].category).toBe('notification');
    });
  });

  describe('global ingressClassifier instance', () => {
    it('should export global instance', () => {
      expect(ingressClassifier).toBeInstanceOf(IngressClassifier);
    });

    it('should work with global instance', () => {
      const message: IngressMessage = {
        id: 'msg-1',
        source: 'discord',
        content: '/test',
        timestamp: '2024-01-01T00:00:00Z',
      };

      const result = ingressClassifier.classify(message);

      expect(result.category).toBe('command');
    });
  });
});
