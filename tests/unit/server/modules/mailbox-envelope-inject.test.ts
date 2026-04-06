/**
 * Mailbox Envelope Inject Prompt 单元测试
 * 测试 buildHeartbeatInjectPrompt / buildHeartbeatEnvelopeWithInject
 */

import { describe, it, expect } from 'vitest';
import {
  buildHeartbeatInjectPrompt,
  buildHeartbeatEnvelopeWithInject,
  type MailboxEnvelope,
} from '../../../../src/server/modules/mailbox-envelope.ts';

describe('Heartbeat Inject Prompt', () => {
  describe('buildHeartbeatInjectPrompt', () => {
    it('RUNNING 状态应该注入控制说明', () => {
      const prompt = buildHeartbeatInjectPrompt('RUNNING');
      expect(prompt).toContain('心跳控制说明');
      expect(prompt).toContain('RUNNING');
      expect(prompt).toContain('正常运行');
      expect(prompt).toContain('✅');
    });

    it('DEGRADED 状态应该注入控制说明（带 ⚠️）', () => {
      const prompt = buildHeartbeatInjectPrompt('DEGRADED');
      expect(prompt).toContain('心跳控制说明');
      expect(prompt).toContain('DEGRADED');
      expect(prompt).toContain('降级运行');
      expect(prompt).toContain('⚠️');
    });

    it('PAUSED 状态应该返回空字符串', () => {
      const prompt = buildHeartbeatInjectPrompt('PAUSED');
      expect(prompt).toBe('');
    });

    it('STOPPED 状态应该返回空字符串', () => {
      const prompt = buildHeartbeatInjectPrompt('STOPPED');
      expect(prompt).toBe('');
    });

    it('包含 mailboxHealth 时应该显示 pending/processing', () => {
      const health = { pending: 10, processing: 5 };
      const prompt = buildHeartbeatInjectPrompt('RUNNING', health);
      expect(prompt).toContain('10 pending');
      expect(prompt).toContain('5 processing');
    });

    it('oldestPendingAgeMs > 300000 时应该显示等待时间', () => {
      const health = {
        pending: 20,
        processing: 3,
        oldestPendingAgeMs: 600000, // 10 分钟
      };
      const prompt = buildHeartbeatInjectPrompt('RUNNING', health);
      expect(prompt).toContain('10 分钟');
    });

    it('oldestPendingAgeMs <= 300000 时不应显示等待时间', () => {
      const health = {
        pending: 5,
        processing: 1,
        oldestPendingAgeMs: 180000, // 3 分钟
      };
      const prompt = buildHeartbeatInjectPrompt('RUNNING', health);
      expect(prompt).not.toContain('最老 pending');
    });

    it('应该包含所有控制工具表格', () => {
      const prompt = buildHeartbeatInjectPrompt('RUNNING');
      expect(prompt).toContain('heartbeat.stop');
      expect(prompt).toContain('heartbeat.resume');
      expect(prompt).toContain('mailbox.health');
      expect(prompt).toContain('mailbox.clear');
      expect(prompt).toContain('mailbox.mark_skip');
    });

    it('应该包含 Agent 决策建议', () => {
      const prompt = buildHeartbeatInjectPrompt('RUNNING');
      expect(prompt).toContain('发现堆积');
      expect(prompt).toContain('发现重复');
      expect(prompt).toContain('任务阻塞');
      expect(prompt).toContain('恢复正常');
    });
  });

  describe('buildHeartbeatEnvelopeWithInject', () => {
    it('应该返回正确的 MailboxEnvelope 结构', () => {
      const envelope = buildHeartbeatEnvelopeWithInject(
        '测试心跳内容',
        'RUNNING',
        { pending: 5, processing: 2 },
      );

      expect(envelope).toHaveProperty('id');
      expect(envelope).toHaveProperty('category');
      expect(envelope).toHaveProperty('title');
      expect(envelope).toHaveProperty('shortDescription');
      expect(envelope).toHaveProperty('fullText');
      expect(envelope).toHaveProperty('metadata');
    });

    it('RUNNING 状态 envelope.fullText 应包含 inject prompt', () => {
      const envelope = buildHeartbeatEnvelopeWithInject('心跳任务', 'RUNNING');
      expect(envelope.fullText).toContain('心跳控制说明');
    });

    it('PAUSED 状态 envelope.fullText 不应包含 inject prompt', () => {
      const envelope = buildHeartbeatEnvelopeWithInject('心跳任务', 'PAUSED');
      expect(envelope.fullText).not.toContain('心跳控制说明');
    });

    it('STOPPED 状态 envelope.fullText 不应包含 inject prompt', () => {
      const envelope = buildHeartbeatEnvelopeWithInject('心跳任务', 'STOPPED');
      expect(envelope.fullText).not.toContain('心跳控制说明');
    });

    it('应该保留原始心跳内容', () => {
      const heartbeatContent = '检查系统状态\n完成巡检任务';
      const envelope = buildHeartbeatEnvelopeWithInject(heartbeatContent, 'RUNNING');
      expect(envelope.fullText).toContain('检查系统状态');
      expect(envelope.fullText).toContain('完成巡检任务');
    });

    it('category 应为 System', () => {
      const envelope = buildHeartbeatEnvelopeWithInject('test', 'RUNNING');
      expect(envelope.category).toBe('System');
    });

    it('title 应为 Heartbeat Task', () => {
      const envelope = buildHeartbeatEnvelopeWithInject('test', 'RUNNING');
      expect(envelope.title).toBe('Heartbeat Task');
    });

    it('priority 应为 low', () => {
      const envelope = buildHeartbeatEnvelopeWithInject('test', 'RUNNING');
      expect(envelope.metadata.priority).toBe('low');
    });

    it('relatedTaskId 应正确传递', () => {
      const envelope = buildHeartbeatEnvelopeWithInject('test', 'RUNNING', undefined, 'project-123');
      expect(envelope.metadata.relatedTaskId).toBe('project-123');
    });

    it('expectedReply 应正确设置', () => {
      const envelope = buildHeartbeatEnvelopeWithInject('test', 'RUNNING');
      expect(envelope.expectedReply).toBeDefined();
      expect(envelope.expectedReply?.format).toBe('text');
      expect(envelope.expectedReply?.optional).toBe(true);
    });
  });
});
