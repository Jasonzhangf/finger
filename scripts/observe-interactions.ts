/**
 * Agent 交互观测脚本
 * 
 * 用法：
 *   pnpm exec tsx scripts/observe-interactions.ts <sessionId>
 *   pnpm exec tsx scripts/observe-interactions.ts              # 自动找最新 session
 *   pnpm exec tsx scripts/observe-interactions.ts --watch      # 持续观测模式
 *   pnpm exec tsx scripts/observe-interactions.ts --session hb-session-finger-system-agent-global
 * 
 * 从真实 ledger 文件提取事件，生成交互流程图。
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── 内联 InteractionObserver（避免编译依赖）──────────

interface AgentEvent {
  timestamp: number;
  timestampISO: string;
  agentId: string;
  agentPath: string;
  eventType: string;
  toolName?: string;
  targetAgentId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  triggerTurn?: boolean;
  details: Record<string, unknown>;
  raw: Record<string, unknown>;
}

interface AgentInteraction {
  from: string;
  to: string;
  type: string;
  timestamp: number;
  timestampISO: string;
  details: string;
}

function resolveFingerRoot(): string {
  return process.env.FINGER_ROOT || path.join(process.env.HOME || '/root', '.finger');
}

function findLatestSession(): string | null {
  const sessionsRoot = path.join(resolveFingerRoot(), 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  const dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
      name: d.name,
      mtime: fs.statSync(path.join(sessionsRoot, d.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return dirs.length > 0 ? dirs[0].name : null;
}

function discoverAgents(sessionRoot: string): Map<string, string> {
  const agents = new Map<string, string>();
  if (!fs.existsSync(sessionRoot)) return agents;

  for (const entry of fs.readdirSync(sessionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ledgerPath = path.join(sessionRoot, entry.name, 'main', 'context-ledger.jsonl');
    if (fs.existsSync(ledgerPath)) {
      agents.set(entry.name, ledgerPath);
    }
  }
  return agents;
}

function parseLedgerEntry(entry: Record<string, unknown>): AgentEvent | null {
  const eventType = String(entry.event_type || entry.event || '').toLowerCase();
  const payload = (entry.payload || {}) as Record<string, unknown>;
  const metadata = (entry.metadata || {}) as Record<string, unknown>;
  const timestamp = (entry.timestamp_ms as number) || Date.parse(entry.timestamp as string) || 0;
  const timestampISO = (entry.timestamp_iso || entry.timestamp || new Date(timestamp).toISOString()) as string;

  let parsedType = 'unknown';
  let toolName: string | undefined;
  let targetAgentId: string | undefined;
  let fromAgentId: string | undefined;
  let toAgentId: string | undefined;
  let triggerTurn: boolean | undefined;

  if (eventType.includes('tool_call') || eventType.includes('tool_use')) {
    parsedType = 'tool_call';
    toolName = (payload.tool_name || payload.name || metadata.tool_name) as string | undefined;
    if (toolName === 'agent.spawn') parsedType = 'spawn';
    if (toolName === 'agent.close') parsedType = 'close';
    if (toolName === 'agent.send_message') parsedType = 'send_message';
    if (toolName === 'agent.followup_task') parsedType = 'followup_task';
    const params = payload.params || payload.arguments || {};
    if (typeof params === 'object' && params) {
      targetAgentId = (params as Record<string, unknown>).target_agent_id as string || (params as Record<string, unknown>).agent_id as string;
      fromAgentId = (params as Record<string, unknown>).from_agent_id as string;
      toAgentId = (params as Record<string, unknown>).to_agent_id as string || (params as Record<string, unknown>).recipient as string;
      triggerTurn = (params as Record<string, unknown>).trigger_turn as boolean;
    }
  } else if (eventType.includes('tool_result')) {
    parsedType = 'tool_result';
    toolName = payload.tool_name as string;
  } else if (eventType.includes('dispatch') && eventType.includes('complete')) {
    parsedType = 'dispatch_complete';
    targetAgentId = (payload.target_agent_id || payload.targetAgentId) as string;
  } else if (eventType.includes('dispatch')) {
    parsedType = 'dispatch';
    targetAgentId = (payload.target_agent_id || payload.targetAgentId) as string;
    fromAgentId = (payload.source_agent_id || payload.sourceAgentId) as string;
  } else if (eventType.includes('turn_start') || eventType.includes('model_round')) {
    parsedType = 'turn_start';
  } else if (eventType.includes('turn_complete') || eventType.includes('finish')) {
    parsedType = 'turn_complete';
  } else if (eventType.includes('digest') || eventType.includes('compact')) {
    parsedType = 'digest';
  } else if (eventType.includes('completion') || eventType.includes('agent_completion')) {
    parsedType = 'completion_notify';
    fromAgentId = (payload.child_id || payload.childId) as string;
    toAgentId = (payload.parent_id || payload.parentId) as string;
  } else if (eventType.includes('mailbox') || eventType.includes('inter_agent')) {
    parsedType = 'mailbox';
    fromAgentId = (payload.from || payload.author) as string;
    toAgentId = (payload.to || payload.recipient) as string;
    triggerTurn = payload.triggerTurn as boolean || payload.trigger_turn as boolean;
  }

  const agentId = (payload.agent_id || metadata.agent_id || '') as string;
  const agentPath = (payload.agent_path || metadata.agent_path || '') as string;

  return { timestamp, timestampISO, agentId, agentPath, eventType: parsedType, toolName, targetAgentId, fromAgentId, toAgentId, triggerTurn, details: payload, raw: entry };
}

function readLedger(filePath: string): AgentEvent[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const events: AgentEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const event = parseLedgerEntry(entry);
      if (event) events.push(event);
    } catch {}
  }
  return events;
}

// 只保留关键事件（过滤噪音）
function isKeyEvent(event: AgentEvent): boolean {
  const type = event.eventType;
  return type !== 'unknown' && type !== 'digest' && type !== 'tool_result';
}

function eventToInteraction(event: AgentEvent): AgentInteraction | null {
  switch (event.eventType) {
    case 'spawn': return { from: event.agentId, to: event.targetAgentId || '?', type: 'spawn', timestamp: event.timestamp, timestampISO: event.timestampISO, details: `spawn → ${event.targetAgentId || '?'}` };
    case 'dispatch': return { from: event.fromAgentId || event.agentId, to: event.targetAgentId || '?', type: 'dispatch', timestamp: event.timestamp, timestampISO: event.timestampISO, details: `dispatch → ${event.targetAgentId || '?'}` };
    case 'send_message': return { from: event.fromAgentId || event.agentId, to: event.toAgentId || '?', type: 'send_message', timestamp: event.timestamp, timestampISO: event.timestampISO, details: `msg(triggerTurn=${event.triggerTurn ?? false}) → ${event.toAgentId || '?'}` };
    case 'followup_task': return { from: event.fromAgentId || event.agentId, to: event.toAgentId || '?', type: 'followup_task', timestamp: event.timestamp, timestampISO: event.timestampISO, details: `task(triggerTurn=${event.triggerTurn ?? true}) → ${event.toAgentId || '?'}` };
    case 'completion_notify': return { from: event.fromAgentId || '?', to: event.toAgentId || '?', type: 'completion', timestamp: event.timestamp, timestampISO: event.timestampISO, details: `done ← ${event.fromAgentId || '?'}` };
    case 'mailbox': return { from: event.fromAgentId || event.agentId, to: event.toAgentId || '?', type: 'mailbox', timestamp: event.timestamp, timestampISO: event.timestampISO, details: `mailbox(triggerTurn=${event.triggerTurn ?? false}) → ${event.toAgentId || '?'}` };
    default: return null;
  }
}

function renderArrow(type: string): string {
  switch (type) {
    case 'spawn': return '──spawn────►';
    case 'dispatch': return '──dispatch──►';
    case 'send_message': return '──msg──────►';
    case 'followup_task': return '──task──────►';
    case 'completion': return '◄──done──────';
    case 'mailbox': return '──mailbox───►';
    default: return '────────────►';
  }
}

// ─── 主程序 ───

function main() {
  const args = process.argv.slice(2);
  const watchMode = args.includes('--watch');
  const sessionArg = args.find(a => !a.startsWith('--'));

  const fingerRoot = resolveFingerRoot();
  const sessionsRoot = path.join(fingerRoot, 'sessions');

  // 确定 session
  let sessionId: string | null = null;
  if (sessionArg) {
    sessionId = sessionArg;
  } else {
    // 自动找最新的 session
    sessionId = findLatestSession();
  }

  if (!sessionId) {
    console.error('No session found. Usage: tsx observe-interactions.ts [sessionId] [--watch]');
    process.exit(1);
  }

  const sessionRoot = path.join(sessionsRoot, sessionId);
  if (!fs.existsSync(sessionRoot)) {
    // 也可能是 system session
    const systemSessionRoot = path.join(fingerRoot, 'system', 'sessions', sessionId);
    if (fs.existsSync(systemSessionRoot)) {
      // use system session
    } else {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }
  }

  console.log(`\nSession: ${sessionId}`);
  console.log(`Path: ${sessionRoot}\n`);

  const agents = discoverAgents(sessionRoot);
  console.log(`Agents found: ${agents.size}`);
  for (const [agentId, ledgerPath] of agents) {
    const stat = fs.statSync(ledgerPath);
    console.log(`  ${agentId} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  }
  console.log('');

  // 收集所有事件
  const allEvents: AgentEvent[] = [];
  for (const [agentId, ledgerPath] of agents) {
    const events = readLedger(ledgerPath);
    for (const e of events) {
      if (!e.agentId) e.agentId = agentId;
    }
    allEvents.push(...events);
  }

  allEvents.sort((a, b) => a.timestamp - b.timestamp);

  // 过滤关键事件
  const keyEvents = allEvents.filter(isKeyEvent);

  // 提取交互
  const interactions: AgentInteraction[] = [];
  for (const event of allEvents) {
    const i = eventToInteraction(event);
    if (i) interactions.push(i);
  }

  // 统计
  const agentSet = new Set<string>();
  for (const e of allEvents) {
    if (e.agentId) agentSet.add(e.agentId);
    if (e.fromAgentId) agentSet.add(e.fromAgentId);
    if (e.toAgentId) agentSet.add(e.toAgentId);
    if (e.targetAgentId) agentSet.add(e.targetAgentId);
  }

  const startTime = allEvents.length > 0 ? allEvents[0].timestamp : 0;
  const endTime = allEvents.length > 0 ? allEvents[allEvents.length - 1].timestamp : 0;
  const durationMs = endTime - startTime;

  // ─── 输出 ───

  const lines: string[] = [];
  lines.push('┌──────────────────────────────────────────────────────────────────────┐');
  lines.push('│                Agent Interaction Flow Diagram                        │');
  lines.push('├──────────────────────────────────────────────────────────────────────┤');
  lines.push(`│ Session: ${sessionId}`);
  lines.push(`│ Agents:  ${Array.from(agentSet).join(', ')}`);
  lines.push(`│ Total Events:  ${allEvents.length}`);
  lines.push(`│ Key Events:    ${keyEvents.length}`);
  lines.push(`│ Interactions:  ${interactions.length}`);
  lines.push(`│ Duration:      ${(durationMs / 1000).toFixed(1)}s`);
  lines.push('├───────────────────���──────────────────────────────────────────────────┤');

  // 交互时间线
  if (interactions.length > 0) {
    lines.push('│ INTERACTIONS:');
    for (const i of interactions) {
      const elapsed = ((i.timestamp - startTime) / 1000).toFixed(1);
      const pad = ' '.repeat(Math.max(0, 8 - elapsed.length));
      const arrow = renderArrow(i.type);
      lines.push(`│ +${elapsed}s${pad} ${i.from} ${arrow} ${i.to}`);
    }
    lines.push('│');
  }

  // 关键事件时间线
  lines.push('├──────────────────────────────────────────────────────────────────────┤');
  lines.push('│ KEY EVENTS:');

  for (const event of keyEvents) {
    const elapsed = ((event.timestamp - startTime) / 1000).toFixed(1);
    const pad = ' '.repeat(Math.max(0, 8 - elapsed.length));
    const typeLabel = event.eventType.padEnd(20);
    const toolLabel = event.toolName ? ` [${event.toolName}]` : '';
    const agentLabel = event.agentId ? ` (${event.agentId})` : '';
    const targetLabel = event.targetAgentId ? ` → ${event.targetAgentId}` : '';
    lines.push(`│ +${elapsed}s${pad} ${typeLabel}${toolLabel}${agentLabel}${targetLabel}`);
  }

  lines.push('└──────────────────────────────────────────────────────────────────────┘');

  console.log(lines.join('\n'));

  // 持续观测模式
  if (watchMode) {
    console.log('\n Watching for new events... (Ctrl+C to stop)\n');
    let lastTimestamp = endTime;
    setInterval(() => {
      const newEvents: AgentEvent[] = [];
      for (const [agentId, ledgerPath] of agents) {
        const events = readLedger(ledgerPath);
        for (const e of events) {
          if (e.timestamp > lastTimestamp) {
            if (!e.agentId) e.agentId = agentId;
            if (isKeyEvent(e)) newEvents.push(e);
          }
        }
      }
      if (newEvents.length > 0) {
        newEvents.sort((a, b) => a.timestamp - b.timestamp);
        for (const e of newEvents) {
          const elapsed = ((e.timestamp - startTime) / 1000).toFixed(1);
          const i = eventToInteraction(e);
          if (i) {
            console.log(`[+${elapsed}s] ${i.from} ${renderArrow(i.type)} ${i.to}  ${i.details}`);
          } else {
            const toolLabel = e.toolName ? ` [${e.toolName}]` : '';
            console.log(`[+${elapsed}s] ${e.eventType}${toolLabel} (${e.agentId})`);
          }
        }
        lastTimestamp = newEvents[newEvents.length - 1].timestamp;
      }
    }, 2000);
  }
}

main();
