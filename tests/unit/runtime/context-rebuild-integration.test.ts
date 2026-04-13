/**
 * Context Rebuild Integration Tests
 * 
 * 测试心跳/循环任务 vs 普通用户请求的 context rebuild 行为
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// Import the functions to test
import {
  executeContextRebuild,
  extractPromptFromPayload,
  estimateMessageTokens,
  extractRecentTaskDigests,
} from '../../../src/runtime/context-rebuild-executor.js';
import {
  decideContextRebuild,
  isHeartbeatSession,
  TopicShiftDetector,
} from '../../../src/runtime/topic-shift-detector.js';

describe('Context Rebuild Integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join('/tmp', 'context-rebuild-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ========================================
  // 1. extractRecentTaskDigests 测试
  // ========================================
  describe('extractRecentTaskDigests', () => {
    it('extracts last 3 rounds from session messages', () => {
      const messages = [
        { role: 'user', content: 'User 1' },
        { role: 'assistant', content: 'Assistant 1' },
        { role: 'user', content: 'User 2' },
        { role: 'assistant', content: 'Assistant 2' },
        { role: 'user', content: 'User 3' },
        { role: 'assistant', content: 'Assistant 3' },
        { role: 'user', content: 'User 4' },  // 最新的
        { role: 'assistant', content: 'Assistant 4' },
      ];

      const result = extractRecentTaskDigests(messages, 3);

      // 应该返回最近 3 轮（User 2-4）
      expect(result.length).toBe(6); // 3 rounds × 2 messages
      expect(result[0].content).toBe('User 2');
      expect(result[1].content).toBe('Assistant 2');
      expect(result[5].content).toBe('Assistant 4');
    });

    it('handles incomplete rounds (only user, no assistant)', () => {
      const messages = [
        { role: 'user', content: 'User 1' },
        { role: 'assistant', content: 'Assistant 1' },
        { role: 'user', content: 'User 2 (no response)' },
      ];

      const result = extractRecentTaskDigests(messages, 3);

      expect(result.length).toBe(3);
      expect(result[2].content).toBe('User 2 (no response)');
    });

    it('skips system messages', () => {
      const messages = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'User 1' },
        { role: 'assistant', content: 'Assistant 1' },
      ];

      const result = extractRecentTaskDigests(messages, 1);

      expect(result.length).toBe(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
    });

    it('returns empty array when no messages', () => {
      const result = extractRecentTaskDigests([], 3);
      expect(result.length).toBe(0);
    });
  });

  // ========================================
  // 2. isHeartbeatSession 测试
  // ========================================
  describe('isHeartbeatSession', () => {
    it('returns true for hb- prefix', () => {
      expect(isHeartbeatSession('hb-session-123')).toBe(true);
    });

    it('returns true for system- prefix', () => {
      expect(isHeartbeatSession('system-heartbeat-456')).toBe(true);
    });

    it('returns false for normal sessions', () => {
      expect(isHeartbeatSession('user-session-789')).toBe(false);
      expect(isHeartbeatSession('normal-session')).toBe(false);
    });
  });

  // ========================================
  // 3. decideContextRebuild 测试
  // ========================================
  describe('decideContextRebuild', () => {
    it('triggers rebuild for heartbeat session (hb- prefix)', () => {
      const detector = new TopicShiftDetector();
      const decision = decideContextRebuild(
        'hb-session-1',  // heartbeat session
        'heartbeat',
        'Check status',
        5000,
        8000,
        null,
        detector,
      );

      expect(decision.shouldRebuild).toBe(true);
      expect(decision.reason).toBe('heartbeat_session');
    });

    it('triggers rebuild for heartbeat session (system- prefix)', () => {
      const detector = new TopicShiftDetector();
      const decision = decideContextRebuild(
        'system-heartbeat-1',
        'heartbeat',
        'Check status',
        5000,
        8000,
        null,
        detector,
      );

      expect(decision.shouldRebuild).toBe(true);
      expect(decision.reason).toBe('heartbeat_session');
    });

    it('triggers rebuild for cron source type', () => {
      const detector = new TopicShiftDetector();
      const decision = decideContextRebuild(
        'user-session-1',  // 不是 hb- session ID
        'cron',  // 但是 cron source type
        'Scheduled task',
        5000,
        8000,
        null,
        detector,
      );

      expect(decision.shouldRebuild).toBe(true);
      expect(decision.reason).toBe('cron_task');
    });

    it('triggers rebuild for explicit keyword (之前)', () => {
      const detector = new TopicShiftDetector();
      const decision = decideContextRebuild(
        'user-session-1',
        'user',
        '之前我们讨论过什么？',  // 包含 "之前"
        5000,
        8000,
        null,
        detector,
      );

      expect(decision.shouldRebuild).toBe(true);
      expect(decision.reason).toBe('explicit_keyword');
    });

    it('triggers rebuild after 3 rounds of high confidence topic shift', () => {
      const detector = new TopicShiftDetector();

      // Simulate 3 rounds of high confidence topic shifts
      // Use shouldTrigger to accumulate confidence internally
      const control1 = { is_new_topic: true, confidence: 0.85, last_topic: 'A', current_topic: 'B' };
      detector.shouldTrigger(control1);  // Round 1: accumulate
      const d1 = decideContextRebuild('user-session', 'user', 'B1', 5000, 8000, control1, detector);
      expect(d1.shouldRebuild).toBe(false);

      const control2 = { is_new_topic: true, confidence: 0.88, last_topic: 'B', current_topic: 'C' };
      detector.shouldTrigger(control2);  // Round 2: accumulate
      const d2 = decideContextRebuild('user-session', 'user', 'C1', 5000, 8000, control2, detector);
      expect(d2.shouldRebuild).toBe(false);

      const control3 = { is_new_topic: true, confidence: 0.90, last_topic: 'C', current_topic: 'D' };
      detector.shouldTrigger(control3);  // Round 3: accumulate
      const d3 = decideContextRebuild('user-session', 'user', 'D1', 5000, 8000, control3, detector);
      expect(d3.shouldRebuild).toBe(true);
      expect(d3.reason).toContain('topic_shift_accumulation');
    });

    it('does NOT trigger rebuild when confidence drops', () => {
      const detector = new TopicShiftDetector();

      // Round 1-2: high confidence
      detector.shouldTrigger({ is_new_topic: true, confidence: 0.85, last_topic: 'A', current_topic: 'B' });
      detector.shouldTrigger({ is_new_topic: true, confidence: 0.88, last_topic: 'B', current_topic: 'C' });

      // Round 3: low confidence (< 0.8) → 不触发，清空累积
      const control3 = { is_new_topic: true, confidence: 0.65, last_topic: 'C', current_topic: 'D' };
      // Actually this case is NOT is_new_topic = true, but confidence < threshold
      // Let me check: shouldTrigger only resets when is_new_topic = false
      // When is_new_topic = true but confidence < threshold, it still accumulates
      // But decideContextRebuild won't trigger if not all recent rounds >= threshold
      detector.shouldTrigger(control3);
      const d3 = decideContextRebuild('user-session', 'user', 'D1', 5000, 8000, control3, detector);
      // After 3 rounds, only 2 of them >= 0.8, so won't trigger
      expect(d3.shouldRebuild).toBe(false);
    });

    it('does NOT trigger rebuild by default (保守策略)', () => {
      const detector = new TopicShiftDetector();
      const decision = decideContextRebuild(
        'user-session-1',
        'user',
        'Hello',
        5000,  // 有历史
        8000,
        null,
        detector,
      );

      expect(decision.shouldRebuild).toBe(false);
      expect(decision.reason).toBe('none');
    });
  });

  // ========================================
  // 4. TopicShiftDetector.shouldTrigger 测试
  // ========================================
  describe('TopicShiftDetector.shouldTrigger', () => {
    it('returns false when no control info', () => {
      const detector = new TopicShiftDetector();
      const result = detector.shouldTrigger(null);
      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toBe('no_control_info');
    });

    it('returns false and resets when not new topic', () => {
      const detector = new TopicShiftDetector();
      detector.shouldTrigger({ is_new_topic: true, confidence: 0.85, last_topic: 'A', current_topic: 'B' });
      const result = detector.shouldTrigger({ is_new_topic: false, confidence: 0.5, last_topic: 'B', current_topic: 'B' });
      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toBe('not_new_topic');
    });

    it('accumulates and triggers after 3 high confidence rounds', () => {
      const detector = new TopicShiftDetector();

      const r1 = detector.shouldTrigger({ is_new_topic: true, confidence: 0.85, last_topic: 'A', current_topic: 'B' });
      expect(r1.shouldTrigger).toBe(false);

      const r2 = detector.shouldTrigger({ is_new_topic: true, confidence: 0.88, last_topic: 'B', current_topic: 'C' });
      expect(r2.shouldTrigger).toBe(false);

      const r3 = detector.shouldTrigger({ is_new_topic: true, confidence: 0.90, last_topic: 'C', current_topic: 'D' });
      expect(r3.shouldTrigger).toBe(true);
      expect(r3.reason).toContain('topic_shift_accumulation');
    });
  });

  // ========================================
  // 5. extractPromptFromPayload 测试
  // ========================================
  describe('extractPromptFromPayload', () => {
    it('extracts from prompt field', () => {
      const payload = { prompt: 'Hello world' };
      expect(extractPromptFromPayload(payload)).toBe('Hello world');
    });

    it('extracts from query field', () => {
      const payload = { query: 'Search this' };
      expect(extractPromptFromPayload(payload)).toBe('Search this');
    });

    it('extracts from content field', () => {
      const payload = { content: 'Some content' };
      expect(extractPromptFromPayload(payload)).toBe('Some content');
    });

    it('returns null when no prompt fields', () => {
      const payload = { foo: 'bar' };
      expect(extractPromptFromPayload(payload)).toBeNull();
    });

    it('returns null for empty string', () => {
      const payload = { prompt: '' };
      expect(extractPromptFromPayload(payload)).toBeNull();
    });
  });

  // ========================================
  // 6. estimateMessageTokens 测试
  // ========================================
  describe('estimateMessageTokens', () => {
    it('estimates tokens correctly (4 chars per token)', () => {
      // Math.ceil(5/4) = 2
      expect(estimateMessageTokens({ content: 'Hello' })).toBe(2);
      // Math.ceil(12/4) = 3
      expect(estimateMessageTokens({ content: 'Hello world!' })).toBe(3);
    });
  });
});
