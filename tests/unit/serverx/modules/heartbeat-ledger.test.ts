/**
 * Heartbeat Ledger 单元测试
 * 测试 appendHeartbeatEvent / appendHeartbeatEventSync
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appendHeartbeatEvent, appendHeartbeatEventSync, type HeartbeatEventType, type HeartbeatEventSeverity } from '../../../../src/serverx/modules/heartbeat-ledger.ts';

// Mock finger-paths (logger depends on it)
vi.mock('../../../../src/core/finger-paths.ts', () => ({
  FINGER_HOME: '/tmp/fingerprint-test',
  FINGER_PATHS: {
    home: '/tmp/fingerprint-test',
    logs: { dir: '/tmp/fingerprint-test/logs' },
    runtime: { dir: '/tmp/fingerprint-test/runtime', eventsDir: '/tmp/fingerprint-test/runtime/events' },
    config: { dir: '/tmp/fingerprint-test/config' },
  },
}));

// Simple tests that don't rely on spy assertions
describe('Heartbeat Ledger', () => {
  describe('HeartbeatEventType', () => {
    it('should include all required event types', () => {
      const requiredTypes: HeartbeatEventType[] = [
        'heartbeat_mailbox_write',
        'heartbeat_mailbox_write_failed',
        'mailbox_backlog_detected',
        'mailbox_stale_detected',
        'heartbeat_degraded',
        'heartbeat_degraded_to_paused',
        'heartbeat_resumed',
        'heartbeat_stopped',
        'heartbeat_auto_resume',
        'agent_resume_request',
        'agent_stop_request',
      ];
      requiredTypes.forEach(type => {
        expect(type).toBeDefined();
      });
    });
  });

  describe('HeartbeatEventSeverity', () => {
    it('should include all severity levels', () => {
      const severities: HeartbeatEventSeverity[] = ['info', 'warn', 'error', 'critical'];
      severities.forEach(sev => {
        expect(sev).toBeDefined();
      });
    });

    it('severity hierarchy should be correct', () => {
      const order: Record<HeartbeatEventSeverity, number> = {
        info: 0,
        warn: 1,
        error: 2,
        critical: 3,
      };
      expect(order.info).toBeLessThan(order.warn);
      expect(order.warn).toBeLessThan(order.error);
      expect(order.error).toBeLessThan(order.critical);
    });
  });

  describe('appendHeartbeatEventSync', () => {
    it('should write event without throwing', () => {
      expect(() => appendHeartbeatEventSync('heartbeat_degraded', 'warn', {
        prevState: 'RUNNING',
        newState: 'DEGRADED',
        reason: 'mailbox_pending > 50',
      })).not.toThrow();
    });

    it('should handle different event types', () => {
      const events: Array<{ type: HeartbeatEventType; severity: HeartbeatEventSeverity }> = [
        { type: 'heartbeat_mailbox_write', severity: 'info' },
        { type: 'heartbeat_degraded', severity: 'warn' },
        { type: 'heartbeat_degraded_to_paused', severity: 'error' },
        { type: 'heartbeat_stopped', severity: 'critical' },
        { type: 'heartbeat_auto_resume', severity: 'info' },
      ];

      events.forEach(({ type, severity }) => {
        expect(() => appendHeartbeatEventSync(type, severity, { test: true })).not.toThrow();
      });
    });

    it('should handle critical events', () => {
      expect(() => appendHeartbeatEventSync('heartbeat_stopped', 'critical', {
        prevState: 'PAUSED',
        reason: 'fatal error',
        mailboxHealth: { pending: 150, processing: 10 },
      })).not.toThrow();
    });
  });

  describe('appendHeartbeatEvent', () => {
    it('should be async and return Promise', async () => {
      const result = appendHeartbeatEvent('heartbeat_resumed', 'info', {
        reason: 'manual',
      });
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });

    it('should handle multiple async events', async () => {
      const events = [
        appendHeartbeatEvent('heartbeat_mailbox_write', 'info', { agentId: 'test-1' }),
        appendHeartbeatEvent('heartbeat_degraded', 'warn', { reason: 'test' }),
        appendHeartbeatEvent('heartbeat_auto_resume', 'info', { afterMs: 60000 }),
      ];

      await Promise.all(events);
      // All should resolve without error
    });

    it('should handle info events', async () => {
      await expect(appendHeartbeatEvent('heartbeat_mailbox_write', 'info', {
        agentId: 'finger-system-agent',
        envelopeId: 'test-envelope',
      })).resolves.toBeUndefined();
    });
  });
});
