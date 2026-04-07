/**
 * Agent Interaction Observer
 * 
 * 从多个 Agent 的 ledger 中提取事件，构建交互流程图。
 * 不做刚性断言，只做观测和可视化。
 * 
 * 数据源：
 *   - context-ledger.jsonl（每个 agent 一个）
 *   - compact-memory.jsonl（digest 事件）
 *   - daemon.log（系统日志）
 * 
 * Task: finger-280.12
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../../src/core/logger.js';

const log = logger.module('InteractionObserver');

// ─── 事件类型 ───

export interface AgentEvent {
  timestamp: number;
  timestampISO: string;
  agentId: string;
  agentPath: string;
  eventType: 'tool_call' | 'tool_result' | 'dispatch' | 'dispatch_complete' | 'spawn' | 'close' | 'send_message' | 'followup_task' | 'completion_notify' | 'digest' | 'turn_start' | 'turn_complete' | 'unknown';
  toolName?: string;
  targetAgentId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  triggerTurn?: boolean;
  details: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface AgentInteraction {
  from: string;
  to: string;
  type: 'spawn' | 'dispatch' | 'send_message' | 'followup_task' | 'completion' | 'tool_call';
  timestamp: number;
  timestampISO: string;
  details: string;
}

export interface InteractionTimeline {
  startTime: number;
  endTime: number;
  durationMs: number;
  events: AgentEvent[];
  interactions: AgentInteraction[];
  agents: Set<string>;
  agentPaths: Map<string, string>;
}

// ─── Ledger 读取 ───

function resolveSessionRoot(sessionId: string): string {
  const fingerRoot = process.env.FINGER_ROOT || path.join(process.env.HOME || '/root', '.finger');
  return path.join(fingerRoot, 'sessions', sessionId);
}

function resolveAgentLedger(sessionRoot: string, agentId: string): string {
  return path.join(sessionRoot, agentId, 'main', 'context-ledger.jsonl');
}

function resolveCompactMemory(sessionRoot: string, agentId: string): string {
  return path.join(sessionRoot, agentId, 'main', 'compact-memory.jsonl');
}

/**
 * 从 ledger 文件读取事件（增量，从 startSeq 开始）
 */
function readLedgerEvents(filePath: string, startSeq: number = 0): AgentEvent[] {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  const events: AgentEvent[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object') continue;

      const event = parseLedgerEntry(entry);
      if (event) events.push(event);
    } catch {
      // skip malformed lines
    }
  }

  return events;
}

/**
 * 解析 ledger 条目为 AgentEvent
 */
function parseLedgerEntry(entry: Record<string, unknown>): AgentEvent | null {
  const eventType = entry.event_type || entry.event || '';
  const payload = (entry.payload || {}) as Record<string, unknown>;
  const metadata = (entry.metadata || {}) as Record<string, unknown>;
  const timestamp = entry.timestamp_ms as number || Date.parse(entry.timestamp as string) || 0;
  const timestampISO = entry.timestamp_iso || entry.timestamp as string || new Date(timestamp).toISOString();

  // 解析事件类型
  let parsedType: AgentEvent['eventType'] = 'unknown';
  let toolName: string | undefined;
  let targetAgentId: string | undefined;
  let fromAgentId: string | undefined;
  let toAgentId: string | undefined;
  let triggerTurn: boolean | undefined;

  const eventStr = String(eventType).toLowerCase();

  if (eventStr.includes('tool_call') || eventStr.includes('tool_use')) {
    parsedType = 'tool_call';
    toolName = payload.tool_name as string || payload.name as string || metadata.tool_name as string;
    
    // 检测 agent-collab 工具调用
    if (toolName === 'agent.spawn') parsedType = 'spawn';
    if (toolName === 'agent.close') parsedType = 'close';
    if (toolName === 'agent.send_message') parsedType = 'send_message';
    if (toolName === 'agent.followup_task') parsedType = 'followup_task';
    
    // 提取 target/from/to
    const params = payload.params || payload.arguments || {};
    if (typeof params === 'object') {
      targetAgentId = params.target_agent_id as string || params.agent_id as string;
      fromAgentId = params.from_agent_id as string;
      toAgentId = params.to_agent_id as string || params.recipient as string;
      triggerTurn = params.trigger_turn as boolean;
    }
  } else if (eventStr.includes('tool_result')) {
    parsedType = 'tool_result';
    toolName = payload.tool_name as string;
  } else if (eventStr.includes('dispatch') && eventStr.includes('complete')) {
    parsedType = 'dispatch_complete';
    targetAgentId = payload.target_agent_id as string || payload.targetAgentId as string;
  } else if (eventStr.includes('dispatch')) {
    parsedType = 'dispatch';
    targetAgentId = payload.target_agent_id as string || payload.targetAgentId as string;
    fromAgentId = payload.source_agent_id as string || payload.sourceAgentId as string;
  } else if (eventStr.includes('turn_start') || eventStr.includes('model_round')) {
    parsedType = 'turn_start';
  } else if (eventStr.includes('turn_complete') || eventStr.includes('finish')) {
    parsedType = 'turn_complete';
  } else if (eventStr.includes('digest') || eventStr.includes('compact')) {
    parsedType = 'digest';
  } else if (eventStr.includes('completion') || eventStr.includes('agent_completion')) {
    parsedType = 'completion_notify';
    fromAgentId = payload.child_id as string || payload.childId as string;
    toAgentId = payload.parent_id as string || payload.parentId as string;
  }

  const agentId = payload.agent_id as string || metadata.agent_id as string || '';
  const agentPath = payload.agent_path as string || metadata.agent_path as string || '';

  return {
    timestamp,
    timestampISO,
    agentId,
    agentPath,
    eventType: parsedType,
    toolName,
    targetAgentId,
    fromAgentId,
    toAgentId,
    triggerTurn,
    details: payload as Record<string, unknown>,
    raw: entry as Record<string, unknown>,
  };
}

// ─── Interaction Observer ───

export class InteractionObserver {
  private sessionRoot: string;
  private agentLedgerPaths: Map<string, string> = new Map();
  private allEvents: AgentEvent[] = [];
  private lastReadTimestamp: number = 0;

  constructor(sessionId: string) {
    this.sessionRoot = resolveSessionRoot(sessionId);
    log.info('InteractionObserver created', { sessionRoot: this.sessionRoot });
  }

  /**
   * 注册要观测的 Agent
   */
  registerAgent(agentId: string): void {
    const ledgerPath = resolveAgentLedger(this.sessionRoot, agentId);
    this.agentLedgerPaths.set(agentId, ledgerPath);
    log.info('Agent registered for observation', { agentId, ledgerPath });
  }

  /**
   * 自动发现 session 下的所有 agent
   */
  discoverAgents(): string[] {
    if (!fs.existsSync(this.sessionRoot)) return [];

    const agents: string[] = [];
    const entries = fs.readdirSync(this.sessionRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const ledgerPath = resolveAgentLedger(this.sessionRoot, entry.name);
        if (fs.existsSync(ledgerPath)) {
          agents.push(entry.name);
          this.agentLedgerPaths.set(entry.name, ledgerPath);
        }
      }
    }

    log.info('Discovered agents', { agents });
    return agents;
  }

  /**
   * 读取所有 agent 的 ledger 事件（增量）
   */
  collectEvents(): AgentEvent[] {
    const newEvents: AgentEvent[] = [];

    for (const [agentId, ledgerPath] of this.agentLedgerPaths) {
      const events = readLedgerEvents(ledgerPath, 0);
      
      for (const event of events) {
        if (event.timestamp > this.lastReadTimestamp) {
          if (!event.agentId) event.agentId = agentId;
          newEvents.push(event);
        }
      }
    }

    // 按时间排序
    newEvents.sort((a, b) => a.timestamp - b.timestamp);

    if (newEvents.length > 0) {
      this.lastReadTimestamp = newEvents[newEvents.length - 1].timestamp;
    }

    this.allEvents.push(...newEvents);
    log.info('Events collected', { newEvents: newEvents.length, totalEvents: this.allEvents.length });

    return newEvents;
  }

  /**
   * 构建交互图
   */
  buildInteractions(): AgentInteraction[] {
    const interactions: AgentInteraction[] = [];

    for (const event of this.allEvents) {
      const interaction = this.eventToInteraction(event);
      if (interaction) interactions.push(interaction);
    }

    return interactions.sort((a, b) => a.timestamp - b.timestamp);
  }

  private eventToInteraction(event: AgentEvent): AgentInteraction | null {
    switch (event.eventType) {
      case 'spawn':
        return {
          from: event.agentId || 'unknown',
          to: event.targetAgentId || event.details.target_agent_id as string || 'unknown',
          type: 'spawn',
          timestamp: event.timestamp,
          timestampISO: event.timestampISO,
          details: `spawn(${event.targetAgentId || '?'})`,
        };
      case 'dispatch':
        return {
          from: event.fromAgentId || event.agentId || 'unknown',
          to: event.targetAgentId || 'unknown',
          type: 'dispatch',
          timestamp: event.timestamp,
          timestampISO: event.timestampISO,
          details: `dispatch → ${event.targetAgentId || '?'}`,
        };
      case 'send_message':
        return {
          from: event.fromAgentId || event.agentId || 'unknown',
          to: event.toAgentId || 'unknown',
          type: 'send_message',
          timestamp: event.timestamp,
          timestampISO: event.timestampISO,
          details: `send_message(triggerTurn=${event.triggerTurn ?? false})`,
        };
      case 'followup_task':
        return {
          from: event.fromAgentId || event.agentId || 'unknown',
          to: event.toAgentId || 'unknown',
          type: 'followup_task',
          timestamp: event.timestamp,
          timestampISO: event.timestampISO,
          details: `followup_task(triggerTurn=${event.triggerTurn ?? true})`,
        };
      case 'completion_notify':
        return {
          from: event.fromAgentId || 'unknown',
          to: event.toAgentId || 'unknown',
          type: 'completion',
          timestamp: event.timestamp,
          timestampISO: event.timestampISO,
          details: `completed(${event.fromAgentId || '?'})`,
        };
      default:
        return null;
    }
  }

  /**
   * 生成时间线
   */
  buildTimeline(): InteractionTimeline {
    const interactions = this.buildInteractions();
    const agents = new Set<string>();
    const agentPaths = new Map<string, string>();

    for (const event of this.allEvents) {
      if (event.agentId) agents.add(event.agentId);
      if (event.agentId && event.agentPath) agentPaths.set(event.agentId, event.agentPath);
    }

    const startTime = this.allEvents.length > 0 ? this.allEvents[0].timestamp : 0;
    const endTime = this.allEvents.length > 0 ? this.allEvents[this.allEvents.length - 1].timestamp : 0;

    return {
      startTime,
      endTime,
      durationMs: endTime - startTime,
      events: this.allEvents,
      interactions,
      agents,
      agentPaths,
    };
  }

  /**
   * 绘制 ASCII 交互流程图
   */
  renderFlowDiagram(): string {
    const interactions = this.buildInteractions();
    const timeline = this.buildTimeline();
    const lines: string[] = [];

    lines.push('┌─────────────────────────────────────────────────────────────────┐');
    lines.push('│               Agent Interaction Flow Diagram                    │');
    lines.push('├─────────────────────────────────────────────────────────────────┤');

    // Agent 列表
    const agentList = Array.from(timeline.agents);
    lines.push(`│ Agents: ${agentList.join(', ')}`);
    lines.push(`│ Duration: ${(timeline.durationMs / 1000).toFixed(1)}s`);
    lines.push(`│ Events: ${this.allEvents.length}`);
    lines.push(`│ Interactions: ${interactions.length}`);
    lines.push('├─────────────────────────────────────────────────────────────────┤');

    // 交互时间线
    const startTime = timeline.startTime;
    for (const i of interactions) {
      const elapsed = ((i.timestamp - startTime) / 1000).toFixed(1);
      const pad = ' '.repeat(Math.max(0, 8 - elapsed.length));
      const arrow = this.renderArrow(i.type);
      lines.push(`│ +${elapsed}s${pad} ${i.from} ${arrow} ${i.to}  ${i.details}`);
    }

    // 所有事件（非交互的也显示）
    lines.push('├─────────────────────────────────────────────────────────────────┤');
    lines.push('│ All Events:');

    for (const event of this.allEvents) {
      const elapsed = ((event.timestamp - startTime) / 1000).toFixed(1);
      const pad = ' '.repeat(Math.max(0, 8 - elapsed.length));
      const typeLabel = event.eventType.padEnd(18);
      const toolLabel = event.toolName ? ` [${event.toolName}]` : '';
      const agentLabel = event.agentId ? ` (${event.agentId})` : '';
      lines.push(`│ +${elapsed}s${pad} ${typeLabel}${toolLabel}${agentLabel}`);
    }

    lines.push('└─────────────────────────────────────────────────────────────────┘');

    return lines.join('\n');
  }

  private renderArrow(type: AgentInteraction['type']): string {
    switch (type) {
      case 'spawn': return '─spawn─►';
      case 'dispatch': return '─dispatch─►';
      case 'send_message': return '─msg─────►';
      case 'followup_task': return '─task────►';
      case 'completion': return '◄─done─────';
      case 'tool_call': return '─tool────►';
      default: return '──────────►';
    }
  }

  /**
   * 检查是否包含预期的交互模式
   */
  matchPattern(pattern: {
    from?: string;
    to?: string;
    type?: AgentInteraction['type'];
    minCount?: number;
    maxCount?: number;
  }): { matched: boolean; count: number; interactions: AgentInteraction[] } {
    const interactions = this.buildInteractions().filter(i => {
      if (pattern.from && i.from !== pattern.from) return false;
      if (pattern.to && i.to !== pattern.to) return false;
      if (pattern.type && i.type !== pattern.type) return false;
      return true;
    });

    const count = interactions.length;
    let matched = true;

    if (pattern.minCount !== undefined && count < pattern.minCount) matched = false;
    if (pattern.maxCount !== undefined && count > pattern.maxCount) matched = false;

    return { matched, count, interactions };
  }

  /**
   * 获取所有事件（只读）
   */
  getAllEvents(): AgentEvent[] {
    return [...this.allEvents];
  }

  /**
   * 重置（清空已收集的事件）
   */
  reset(): void {
    this.allEvents = [];
    this.lastReadTimestamp = 0;
  }
}
