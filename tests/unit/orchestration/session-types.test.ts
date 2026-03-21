import { describe, it, expect } from 'vitest';
import { LEDGER_POINTER_DEFAULTS, ensureLedgerPointers, type Session, type SessionMessage } from '../../../src/orchestration/session-types.js';

describe('session-types', () => {
  describe('LEDGER_POINTER_DEFAULTS', () => {
    it('should have default ledger pointer values', () => {
      expect(LEDGER_POINTER_DEFAULTS).toEqual({
        ledgerPath: '',
        latestCompactIndex: -1,
        originalStartIndex: 0,
        originalEndIndex: 0,
        totalTokens: 0,
      });
    });

    it('should be frozen/readonly', () => {
      // TypeScript const assertions make it readonly at compile time
      // Runtime check: the values should be primitives
      expect(typeof LEDGER_POINTER_DEFAULTS.ledgerPath).toBe('string');
      expect(typeof LEDGER_POINTER_DEFAULTS.latestCompactIndex).toBe('number');
      expect(typeof LEDGER_POINTER_DEFAULTS.originalStartIndex).toBe('number');
      expect(typeof LEDGER_POINTER_DEFAULTS.originalEndIndex).toBe('number');
      expect(typeof LEDGER_POINTER_DEFAULTS.totalTokens).toBe('number');
    });
  });

  describe('ensureLedgerPointers', () => {
    it('should add ledger pointer fields to session without them', () => {
      const legacySession = {
        id: 'test-session',
        name: 'Test Session',
        projectPath: '/test/path',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        messages: [],
        activeWorkflows: [],
        context: {},
      } as unknown as Session;

      const result = ensureLedgerPointers(legacySession);

      expect(result.ledgerPath).toBe('');
      expect(result.latestCompactIndex).toBe(-1);
      expect(result.originalStartIndex).toBe(0);
      expect(result.originalEndIndex).toBe(0);
      expect(result.totalTokens).toBe(0);
    });

    it('should preserve existing ledger pointer fields', () => {
      const sessionWithPointers: Session = {
        id: 'test-session',
        name: 'Test Session',
        projectPath: '/test/path',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        messages: [],
        activeWorkflows: [],
        context: {},
        ledgerPath: '/custom/ledger/path',
        latestCompactIndex: 5,
        originalStartIndex: 10,
        originalEndIndex: 20,
        totalTokens: 1500,
      };

      const result = ensureLedgerPointers(sessionWithPointers);

      expect(result.ledgerPath).toBe('/custom/ledger/path');
      expect(result.latestCompactIndex).toBe(5);
      expect(result.originalStartIndex).toBe(10);
      expect(result.originalEndIndex).toBe(20);
      expect(result.totalTokens).toBe(1500);
    });

    it('should handle null/undefined values by replacing with defaults', () => {
      const sessionWithNulls = {
        id: 'test-session',
        name: 'Test Session',
        projectPath: '/test/path',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        messages: [],
        activeWorkflows: [],
        context: {},
        ledgerPath: '',
        latestCompactIndex: null,
        originalStartIndex: undefined,
        originalEndIndex: null,
        totalTokens: undefined,
      } as unknown as Session;

      const result = ensureLedgerPointers(sessionWithNulls);

      expect(result.latestCompactIndex).toBe(-1);
      expect(result.originalStartIndex).toBe(0);
      expect(result.originalEndIndex).toBe(0);
      expect(result.totalTokens).toBe(0);
    });

    it('should return the same session object (mutated)', () => {
      const session = {
        id: 'test-session',
        name: 'Test Session',
        projectPath: '/test/path',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        lastAccessedAt: '2026-01-01T00:00:00Z',
        messages: [],
        activeWorkflows: [],
        context: {},
      } as unknown as Session;

      const result = ensureLedgerPointers(session);
      expect(result).toBe(session); // Same reference
    });
  });

  describe('Session interface', () => {
    it('should have messages field marked as deprecated', () => {
      // This is a compile-time check via @deprecated JSDoc
      // Runtime: messages field should still exist
      const session: Session = {
        id: 'test',
        name: 'Test',
        projectPath: '/test',
        createdAt: '',
        updatedAt: '',
        lastAccessedAt: '',
        messages: [],
        activeWorkflows: [],
        context: {},
        ledgerPath: '',
        latestCompactIndex: -1,
        originalStartIndex: 0,
        originalEndIndex: 0,
        totalTokens: 0,
      };
      expect(Array.isArray(session.messages)).toBe(true);
    });

    it('should support _cachedView as optional memory-only field', () => {
      const session: Session = {
        id: 'test',
        name: 'Test',
        projectPath: '/test',
        createdAt: '',
        updatedAt: '',
        lastAccessedAt: '',
        messages: [],
        activeWorkflows: [],
        context: {},
        ledgerPath: '',
        latestCompactIndex: -1,
        originalStartIndex: 0,
        originalEndIndex: 0,
        totalTokens: 0,
      };
      // _cachedView is optional and memory-only
      expect(session._cachedView).toBeUndefined();
    });
  });

  describe('SessionMessage interface', () => {
    it('should support all required and optional fields', () => {
      const message: SessionMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: '2026-01-01T00:00:00Z',
        workflowId: 'wf-1',
        taskId: 'task-1',
        type: 'text',
        agentId: 'agent-1',
        toolName: 'test-tool',
        toolStatus: 'success',
        toolDurationMs: 100,
        toolInput: { arg: 'value' },
        toolOutput: { result: 'ok' },
        metadata: { key: 'value' },
      };

      expect(message.id).toBe('msg-1');
      expect(message.role).toBe('user');
      expect(message.content).toBe('Hello');
      expect(message.type).toBe('text');
      expect(message.toolStatus).toBe('success');
    });

    it('should support ledger_pointer type for referencing child sessions', () => {
      const message: SessionMessage = {
        id: 'msg-2',
        role: 'assistant',
        content: 'Task dispatched',
        timestamp: '2026-01-01T00:00:00Z',
        type: 'ledger_pointer',
        metadata: {
          childSessionId: 'session-child',
          ledgerPath: '/path/to/ledger',
        },
      };

      expect(message.type).toBe('ledger_pointer');
      expect(message.metadata?.childSessionId).toBe('session-child');
    });

    it('should support reasoning type for model thoughts', () => {
      const message: SessionMessage = {
        id: 'msg-3',
        role: 'assistant',
        content: 'Thinking about the problem...',
        timestamp: '2026-01-01T00:00:00Z',
        type: 'reasoning',
      };

      expect(message.type).toBe('reasoning');
    });
  });
});
