/**
 * Tests for Topic Shift Gate
 * 
 * Epic 283.1: 回归测试与验证脚本
 * 
 * Covers:
 * 1. 连续换题触发重建
 * 2. 单轮误判不触发
 * 3. 高频抖动不触发
 * 4. goal transition 一致性
 * 5. cooldown 机制
 */

import { describe, it, expect } from 'vitest';
import {
  resolveTopicShiftRecheck,
  buildRecheckInputFromWindow,
  type TopicShiftRecheckInput,
  type TopicShiftRecheckResult,
} from '../../src/common/topic-shift-gate.js';

describe('TopicShiftGate', () => {
  describe('resolveTopicShiftRecheck', () => {
    it('should trigger rebuild when 2+ turns have high confidence and mean >= 75', async () => {
      const input = buildRecheckInputFromWindow(
        'test-session',
        'test-agent',
        [
          { turnId: 't1', confidence: 78, fromTopic: 'old-task', toTopic: 'new-task' },
          { turnId: 't2', confidence: 82, fromTopic: 'old-task', toTopic: 'new-task' },
          { turnId: 't3', confidence: 76, fromTopic: 'old-task', toTopic: 'new-task' },
        ],
        'Complete the old task implementation',
        'Start the new feature development',
      );

      const result = await resolveTopicShiftRecheck(input, { sessionId: 'test-session', agentId: 'test-agent' });

      expect(result.should_rebuild).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(75);
      expect(result.reason).toContain('rule_based_rebuild_approved');
    });

    it('should NOT trigger rebuild when only 1 turn has high confidence', async () => {
      const input = buildRecheckInputFromWindow(
        'test-session',
        'test-agent',
        [
          { turnId: 't1', confidence: 78, fromTopic: 'old-task', toTopic: 'new-task' },
          { turnId: 't2', confidence: 45, fromTopic: 'old-task', toTopic: 'old-task' },
          { turnId: 't3', confidence: 50, fromTopic: 'old-task', toTopic: 'old-task' },
        ],
        'Complete the old task implementation',
        'Start the new feature development',
      );

      const result = await resolveTopicShiftRecheck(input, { sessionId: 'test-session', agentId: 'test-agent' });

      expect(result.should_rebuild).toBe(false);
      expect(result.reason).toContain('rule_based_rebuild_rejected');
    });

    it('should NOT trigger rebuild when confidence oscillates (high-frequency jitter)', async () => {
      const input = buildRecheckInputFromWindow(
        'test-session',
        'test-agent',
        [
          { turnId: 't1', confidence: 80, fromTopic: 'task-a', toTopic: 'task-b' },
          { turnId: 't2', confidence: 55, fromTopic: 'task-b', toTopic: 'task-a' },
          { turnId: 't3', confidence: 78, fromTopic: 'task-a', toTopic: 'task-b' },
        ],
        'Working on task A',
        'Working on task B',
      );

      const result = await resolveTopicShiftRecheck(input, { sessionId: 'test-session', agentId: 'test-agent' });

      // Mean is ~71, which is below threshold
      expect(result.should_rebuild).toBe(false);
      expect(result.confidence).toBeLessThan(75);
    });

    it('should NOT trigger rebuild when goals are identical (no transition)', async () => {
      const input = buildRecheckInputFromWindow(
        'test-session',
        'test-agent',
        [
          { turnId: 't1', confidence: 80, fromTopic: 'same-task', toTopic: 'same-task' },
          { turnId: 't2', confidence: 82, fromTopic: 'same-task', toTopic: 'same-task' },
          { turnId: 't3', confidence: 78, fromTopic: 'same-task', toTopic: 'same-task' },
        ],
        'Same task description',
        'Same task description',
      );

      const result = await resolveTopicShiftRecheck(input, { sessionId: 'test-session', agentId: 'test-agent' });

      expect(result.should_rebuild).toBe(false);
      expect(result.reason).toContain('transition=false');
    });

    it('should assess higher risk when pending task anchor exists', async () => {
      const inputWithPending = buildRecheckInputFromWindow(
        'test-session',
        'test-agent',
        [
          { turnId: 't1', confidence: 80, fromTopic: 'old', toTopic: 'new' },
          { turnId: 't2', confidence: 82, fromTopic: 'old', toTopic: 'new' },
        ],
        'Previous goal description',
        'New goal description',
        'Pending task: fix the authentication bug',
        'User wants to switch to new feature',
      );

      const inputWithoutPending = buildRecheckInputFromWindow(
        'test-session',
        'test-agent',
        [
          { turnId: 't1', confidence: 80, fromTopic: 'old', toTopic: 'new' },
          { turnId: 't2', confidence: 82, fromTopic: 'old', toTopic: 'new' },
        ],
        'Previous goal description',
        'New goal description',
      );

      const resultWithPending = await resolveTopicShiftRecheck(inputWithPending, { sessionId: 'test-session', agentId: 'test-agent' });
      const resultWithoutPending = await resolveTopicShiftRecheck(inputWithoutPending, { sessionId: 'test-session', agentId: 'test-agent' });

      expect(resultWithPending.risk_of_forgetting_recent).toBeLessThanOrEqual(30);
      expect(resultWithoutPending.risk_of_forgetting_recent).toBeGreaterThanOrEqual(40);
    });

    it('should reject rebuild when mean confidence is below threshold even with clear transition', async () => {
      const input = buildRecheckInputFromWindow(
        'test-session',
        'test-agent',
        [
          { turnId: 't1', confidence: 60, fromTopic: 'old-task', toTopic: 'new-task' },
          { turnId: 't2', confidence: 65, fromTopic: 'old-task', toTopic: 'new-task' },
          { turnId: 't3', confidence: 70, fromTopic: 'old-task', toTopic: 'new-task' },
        ],
        'Complete the old task implementation',
        'Start the new feature development',
      );

      const result = await resolveTopicShiftRecheck(input, { sessionId: 'test-session', agentId: 'test-agent' });

      // Mean is ~65, below threshold of 75
      expect(result.should_rebuild).toBe(false);
    });
  });

  describe('buildRecheckInputFromWindow', () => {
    it('should correctly build input from window entries', () => {
      const entries = [
        { turnId: 't1', confidence: 80, fromTopic: 'topic-a', toTopic: 'topic-b', rationale: 'User changed subject' },
        { turnId: 't2', confidence: 75, fromTopic: 'topic-a', toTopic: 'topic-b', rationale: 'Continued new topic' },
      ];

      const input = buildRecheckInputFromWindow(
        'session-123',
        'agent-456',
        entries,
        'Goal A: implement feature X',
        'Goal B: refactor module Y',
        'pending-task-anchor',
        'recent-user-intent',
      );

      expect(input.sessionId).toBe('session-123');
      expect(input.agentId).toBe('agent-456');
      expect(input.windowSize).toBe(2);
      expect(input.confidenceSequence).toEqual([80, 75]);
      expect(input.previousGoal).toBe('Goal A: implement feature X');
      expect(input.currentGoal).toBe('Goal B: refactor module Y');
      expect(input.pendingTaskAnchor).toBe('pending-task-anchor');
      expect(input.recentUserIntent).toBe('recent-user-intent');
      expect(input.evidenceSummary).toContain('t1:conf=80');
      expect(input.evidenceSummary).toContain('t2:conf=75');
    });

    it('should handle empty entries array', () => {
      const input = buildRecheckInputFromWindow(
        'session-empty',
        'agent-empty',
        [],
        'Previous goal',
        'Current goal',
      );

      expect(input.windowSize).toBe(0);
      expect(input.confidenceSequence).toEqual([]);
      expect(input.evidenceSummary).toBe('');
    });
  });

  describe('Cooldown and consistency checks', () => {
    // Note: These tests would require a stateful gate implementation
    // For now, we test the decision logic that would be used by cooldown manager

    it('should produce stable decision when goals are consistent across turns', async () => {
      // Simulating 3 consistent turns with same goal transition
      const consistentEntries = [
        { turnId: 't1', confidence: 80, fromTopic: 'task-a', toTopic: 'task-b' },
        { turnId: 't2', confidence: 82, fromTopic: 'task-a', toTopic: 'task-b' },
        { turnId: 't3', confidence: 78, fromTopic: 'task-a', toTopic: 'task-b' },
      ];

      const input = buildRecheckInputFromWindow(
        'test-session',
        'test-agent',
        consistentEntries,
        'Task A: implement authentication',
        'Task B: add rate limiting',
      );

      const result = await resolveTopicShiftRecheck(input, { sessionId: 'test-session', agentId: 'test-agent' });

      expect(result.should_rebuild).toBe(true);
      expect(result.reason).toContain('rule_based_rebuild_approved');
    });
  });
});
