/**
 * Heartbeat 状态 E2E 测试 (278.10)
 * 
 * 测试场景：
 * 1. 完整状态转换流程（RUNNING → DEGRADED → PAUSED → RUNNING → STOPPED）
 * 2. Ledger 审计验证（事件顺序 + severity）
 * 3. Inject Prompt 验证（RUNNING 有注入，PAUSED 无）
 * 
 * 简化策略：不启动完整 daemon，直接测试状态机 + Ledger + Inject Prompt 协同
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MailboxBlock } from '../../../src/blocks/mailbox-block/index.js';
import { appendHeartbeatEventSync, clearHeartbeatLedger, type HeartbeatEventType, type HeartbeatEventSeverity } from '../../../src/serverx/modules/heartbeat-ledger.js';
import { buildHeartbeatInjectPrompt } from '../../../src/server/modules/mailbox-envelope.js';
import { FINGER_PATHS } from '../../../src/core/finger-paths.js';
import fs from 'fs/promises';
import path from 'path';

// Mock finger-paths for test isolation
vi.mock('../../../src/core/finger-paths.js', () => ({
  FINGER_HOME: '/tmp/finger-test-e2e-heartbeat',
  FINGER_PATHS: {
    home: '/tmp/finger-test-e2e-heartbeat',
    config: {
      dir: '/tmp/finger-test-e2e-heartbeat/config',
      promptsDir: '/tmp/finger-test-e2e-heartbeat/config/prompts',
      file: {
        main: '/tmp/finger-test-e2e-heartbeat/config/config.json',
        sessionControlPlane: '/tmp/finger-test-e2e-heartbeat/config/session-control-plane.json',
      },
    },
    runtime: {
      dir: '/tmp/finger-test-e2e-heartbeat/runtime',
      agentsDir: '/tmp/finger-test-e2e-heartbeat/runtime/agents',
      eventsDir: '/tmp/finger-test-e2e-heartbeat/runtime/events',
    },
    logs: {
      dir: '/tmp/finger-test-e2e-heartbeat/logs',
      daemonLog: '/tmp/finger-test-e2e-heartbeat/logs/daemon.log',
    },
    sessions: {
      dir: '/tmp/finger-test-e2e-heartbeat/sessions',
    },
    tmp: {
      dir: '/tmp/finger-test-e2e-heartbeat/tmp',
    },
  },
}));

// Mock chat-codex
vi.mock('../../../src/agents/chat-codex/chat-codex-module.js', () => ({
  ChatCodexModule: vi.fn(),
}));

vi.mock('../../../src/agents/chat-codex/coding-cli-system-prompt.js', () => ({
  resolveCodingCliSystemPrompt: vi.fn(() => ''),
}));

const testRootDir = '/tmp/finger-test-e2e-heartbeat';

describe('Heartbeat State E2E', () => {
  let mailbox: MailboxBlock;
  let ledgerPath: string;

  beforeEach(async () => {
    // Setup test directories
    await fs.mkdir(path.join(testRootDir, 'runtime', 'events'), { recursive: true });
    await fs.mkdir(path.join(testRootDir, 'logs'), { recursive: true });
    
    mailbox = new MailboxBlock();
    // Ledger path from mocked FINGER_PATHS
    ledgerPath = path.join(testRootDir, 'runtime', 'events', 'heartbeat-events.jsonl');
    
    // Clear ledger before each test
    try {
      await fs.unlink(ledgerPath);
    } catch {}
  });

  afterEach(async () => {
    // Cleanup test directories
    try {
      await fs.rm(testRootDir, { recursive: true, force: true });
    } catch {}
  });

  describe('State Transition Flow', () => {
    it('should transition RUNNING → DEGRADED when pending > 50', async () => {
      // Initial state: RUNNING
      const initialState = 'RUNNING';
      
      // Simulate mailbox backlog
      for (let i = 0; i < 51; i++) {
        mailbox.append('test-agent', { title: `msg-${i}` });
      }
      
      const health = mailbox.getHealth();
      
      // Evaluate state transition
      const newState = evaluateState(initialState, health);
      expect(newState).toBe('DEGRADED');
      
      // Write to Ledger
      appendHeartbeatEventSync('heartbeat_degraded', 'warn', {
        prevState: initialState,
        newState,
        mailboxHealth: { pending: health.pending },
        reason: 'pending > 50',
      });
      
      // Verify Ledger
      const ledgerContent = await fs.readFile(ledgerPath, 'utf-8');
      const events = ledgerContent.trim().split('\n').map(JSON.parse);
      expect(events.length).toBe(1);
      expect(events[0].event_type).toBe('heartbeat_degraded');
      expect(events[0].severity).toBe('warn');
    });

    it('should transition DEGRADED → PAUSED when pending > 100', async () => {
      // Initial state: DEGRADED
      const initialState = 'DEGRADED';
      
      // Simulate severe backlog
      for (let i = 0; i < 101; i++) {
        mailbox.append('test-agent', { title: `msg-${i}` });
      }
      
      const health = mailbox.getHealth();
      
      // Evaluate state transition
      const newState = evaluateState(initialState, health);
      expect(newState).toBe('PAUSED');
      
      // Write to Ledger
      appendHeartbeatEventSync('heartbeat_degraded_to_paused', 'error', {
        prevState: initialState,
        newState,
        mailboxHealth: { pending: health.pending },
        reason: 'pending > 100',
      });
      
      // Verify Ledger
      const ledgerContent = await fs.readFile(ledgerPath, 'utf-8');
      const events = ledgerContent.trim().split('\n').map(JSON.parse);
      expect(events[0].event_type).toBe('heartbeat_degraded_to_paused');
      expect(events[0].severity).toBe('error');
    });

    it('should transition PAUSED → RUNNING when cleared', async () => {
      // Initial state: PAUSED
      const initialState = 'PAUSED';
      
      // Mailbox cleared
      mailbox.removeAll();
      
      const health = mailbox.getHealth();
      
      // Evaluate state transition
      const newState = evaluateState(initialState, health);
      expect(newState).toBe('RUNNING');
      
      // Write to Ledger
      appendHeartbeatEventSync('heartbeat_resumed', 'info', {
        prevState: initialState,
        newState,
        reason: 'mailbox cleared',
      });
      
      // Verify Ledger
      const ledgerContent = await fs.readFile(ledgerPath, 'utf-8');
      const events = ledgerContent.trim().split('\n').map(JSON.parse);
      expect(events[0].event_type).toBe('heartbeat_resumed');
      expect(events[0].severity).toBe('info');
    });

    it('should transition any → STOPPED when permanent stop', async () => {
      const initialState = 'RUNNING';
      
      // Permanent stop
      appendHeartbeatEventSync('heartbeat_stopped', 'critical', {
        prevState: initialState,
        newState: 'STOPPED',
        reason: 'permanent stop requested',
      });
      
      // Verify Ledger
      const ledgerContent = await fs.readFile(ledgerPath, 'utf-8');
      const events = ledgerContent.trim().split('\n').map(JSON.parse);
      expect(events[0].event_type).toBe('heartbeat_stopped');
      expect(events[0].severity).toBe('critical');
    });
  });

  describe('Ledger Audit Trail', () => {
    it('should record complete state transition sequence', async () => {
      // Simulate complete flow
      const states = ['RUNNING', 'DEGRADED', 'PAUSED', 'RUNNING', 'STOPPED'];
      const events: Array<{ type: HeartbeatEventType; severity: HeartbeatEventSeverity }> = [
        { type: 'heartbeat_degraded', severity: 'warn' },
        { type: 'heartbeat_degraded_to_paused', severity: 'error' },
        { type: 'heartbeat_resumed', severity: 'info' },
        { type: 'heartbeat_stopped', severity: 'critical' },
      ];
      
      for (let i = 0; i < events.length; i++) {
        appendHeartbeatEventSync(events[i].type, events[i].severity, {
          prevState: states[i],
          newState: states[i + 1],
          testSequence: i,
        });
      }
      
      // Verify Ledger sequence
      const ledgerContent = await fs.readFile(ledgerPath, 'utf-8');
      const ledgerEvents = ledgerContent.trim().split('\n').map(JSON.parse);
      
      expect(ledgerEvents.length).toBe(4);
      
      // Verify sequence
      expect(ledgerEvents[0].event_type).toBe('heartbeat_degraded');
      expect(ledgerEvents[1].event_type).toBe('heartbeat_degraded_to_paused');
      expect(ledgerEvents[2].event_type).toBe('heartbeat_resumed');
      expect(ledgerEvents[3].event_type).toBe('heartbeat_stopped');
      
      // Verify severity progression
      expect(ledgerEvents[0].severity).toBe('warn');
      expect(ledgerEvents[1].severity).toBe('error');
      expect(ledgerEvents[2].severity).toBe('info');
      expect(ledgerEvents[3].severity).toBe('critical');
    });

    it('should include timestamp and metadata in events', async () => {
      appendHeartbeatEventSync('heartbeat_degraded', 'warn', {
        prevState: 'RUNNING',
        newState: 'DEGRADED',
        mailboxHealth: { pending: 51, processing: 0 },
        reason: 'test metadata',
      });
      
      const ledgerContent = await fs.readFile(ledgerPath, 'utf-8');
      const event = JSON.parse(ledgerContent.trim());
      
      expect(event.timestamp_ms).toBeDefined();
      expect(event.payload.prevState).toBe('RUNNING');
      expect(event.payload.newState).toBe('DEGRADED');
      expect(event.payload.mailboxHealth.pending).toBe(51);
    });
  });

  describe('Inject Prompt', () => {
    it('should inject control prompt in RUNNING state', async () => {
      const injectPrompt = buildHeartbeatInjectPrompt('RUNNING', {
        pending: 10,
        processing: 2,
      });
      
      expect(injectPrompt).toContain('心跳控制说明');
      expect(injectPrompt).toContain('RUNNING');
    });

    it('should inject control prompt in DEGRADED state', async () => {
      const injectPrompt = buildHeartbeatInjectPrompt('DEGRADED', {
        pending: 51,
        processing: 5,
        oldestPendingAgeMs: 1200000,
      });
      
      expect(injectPrompt).toContain('DEGRADED');
      expect(injectPrompt).toContain('51 pending');
    });

    it('should not inject prompt in PAUSED state', async () => {
      const injectPrompt = buildHeartbeatInjectPrompt('PAUSED', {
        pending: 100,
        processing: 10,
      });
      
      expect(injectPrompt).toBe('');
    });

    it('should not inject prompt in STOPPED state', async () => {
      const injectPrompt = buildHeartbeatInjectPrompt('STOPPED');
      
      expect(injectPrompt).toBe('');
    });
  });
});

/**
 * Simplified state evaluation logic (mirrors scheduler logic)
 */
function evaluateState(currentState: string, health: { pending: number; processing: number }): string {
  if (currentState === 'STOPPED') return 'STOPPED';
  
  if (currentState === 'PAUSED') {
    // Resume if healthy
    if (health.pending <= 20 && health.processing === 0) {
      return 'RUNNING';
    }
    return 'PAUSED';
  }
  
  if (currentState === 'DEGRADED') {
    // Further degrade if severe
    if (health.pending > 100) {
      return 'PAUSED';
    }
    // Recover if healthy
    if (health.pending <= 20 && health.processing === 0) {
      return 'RUNNING';
    }
    return 'DEGRADED';
  }
  
  // RUNNING
  if (health.pending > 50 || health.processing > 10) {
    return 'DEGRADED';
  }
  
  return 'RUNNING';
}
