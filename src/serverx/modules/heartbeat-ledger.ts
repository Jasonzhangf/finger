/**
 * Heartbeat Ledger - 审计追踪心跳状态转换事件
 */

import fs from 'fs';
import path from 'path';
import { FINGER_HOME } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';

const log = logger.module('HeartbeatLedger');

const LEDGER_DIR = path.join(FINGER_HOME, 'runtime', 'events');
const LEDGER_PATH = path.join(LEDGER_DIR, 'heartbeat-events.jsonl');

export type HeartbeatEventType =
  | 'heartbeat_mailbox_write'
  | 'heartbeat_mailbox_write_failed'
  | 'mailbox_backlog_detected'
  | 'mailbox_stale_detected'
  | 'heartbeat_degraded'
  | 'heartbeat_degraded_to_paused'
  | 'heartbeat_resumed'
  | 'heartbeat_stopped'
  | 'heartbeat_auto_resume'
  | 'agent_stop_request'
  | 'agent_resume_request'
  | 'mailbox_cleared'
  | 'mailbox_marked_skip';

export type HeartbeatEventSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface HeartbeatLedgerEvent {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  event_type: HeartbeatEventType;
  severity: HeartbeatEventSeverity;
  payload: Record<string, unknown>;
}

/**
 * 写入心跳事件到 Ledger
 */
export async function appendHeartbeatEvent(
  eventType: HeartbeatEventType,
  severity: HeartbeatEventSeverity,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    // 确保 events 目录存在
    await fs.promises.mkdir(LEDGER_DIR, { recursive: true });
    
    const now = Date.now();
    const event: HeartbeatLedgerEvent = {
      id: `hb-${now}-${Math.floor(Math.random() * 1_000_000)}`,
      timestamp_ms: now,
      timestamp_iso: new Date(now).toISOString(),
      event_type: eventType,
      severity,
      payload,
    };
    
    await fs.promises.appendFile(LEDGER_PATH, `${JSON.stringify(event)}\n`, 'utf-8');
    
    log.debug('[HeartbeatLedger] Event written', { eventType, severity, eventId: event.id });
  } catch (err) {
    log.error('[HeartbeatLedger] Failed to write event', err instanceof Error ? err : undefined, {
      eventType,
      severity,
      ledgerPath: LEDGER_PATH,
    });
  }
}

/**
 * 同步写入心跳事件（用于关键事件）
 */
export function appendHeartbeatEventSync(
  eventType: HeartbeatEventType,
  severity: HeartbeatEventSeverity,
  payload: Record<string, unknown>,
): void {
  try {
    // 确保 events 目录存在
    if (!fs.existsSync(LEDGER_DIR)) {
      fs.mkdirSync(LEDGER_DIR, { recursive: true });
    }
    
    const now = Date.now();
    const event: HeartbeatLedgerEvent = {
      id: `hb-${now}-${Math.floor(Math.random() * 1_000_000)}`,
      timestamp_ms: now,
      timestamp_iso: new Date(now).toISOString(),
      event_type: eventType,
      severity,
      payload,
    };
    
    fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(event)}\n`, 'utf-8');
    
    log.debug('[HeartbeatLedger] Event written (sync)', { eventType, severity, eventId: event.id });
  } catch (err) {
    log.error('[HeartbeatLedger] Failed to write event (sync)', err instanceof Error ? err : undefined, {
      eventType,
      severity,
      ledgerPath: LEDGER_PATH,
    });
  }
}
