/**
 * Agent Collaboration Tools - LLM-callable tool implementations
 * 
 * Provides 6 tools for Project Agent internal multi-agent collaboration:
 * - agent.spawn: Spawn a child agent with optional role/history fork
 * - agent.wait: Wait for child agent completion (blocking or timeout)
 * - agent.send_message: Send message to another agent (queue only)
 * - agent.followup_task: Send message with trigger_turn=true
 * - agent.close: Close an agent by id or path
 * - agent.list: List active agents
 * 
 * Inspired by Codex Rust multi-agent architecture.
 */

import { logger } from '../../core/logger.js';
import type { MailboxBlock } from '../../blocks/mailbox-block/index.js';
import type { AgentRegistry, SpawnReservationOptions, AgentMetadata } from '../../orchestration/agent-registry.js';
import type { CompletionWatcher } from '../../orchestration/agent-collab-watcher.js';
import { AgentPath } from '../../common/agent-path.js';
import type { InternalTool } from './types.js';

const log = logger.module('AgentCollabTools');

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface AgentSpawnParams {
  message: string;
  role?: 'default' | 'explorer' | 'worker' | 'reviewer';
  fork_history?: 'FullHistory' | 'LastNTurns' | 'None';
  max_threads?: number;
}

export interface AgentWaitParams {
  agent_id?: string;
  agent_path?: string;
  timeout_ms?: number;
}

export interface AgentSendMessageParams {
  recipient: string;
  content: string | object;
  other_recipients?: string[];
}

export interface AgentFollowupTaskParams extends AgentSendMessageParams {
  interrupt?: boolean;
}

export interface AgentCloseParams {
  agent_id?: string;
  agent_path?: string;
}

export interface AgentListParams {
  path_prefix?: string;
}

export interface AgentCollabContext {
  registry: AgentRegistry;
  mailbox: MailboxBlock;
  currentPath: AgentPath;
  currentId: string;
  spawnAgent: (params: AgentSpawnParams, childPath: AgentPath) => Promise<{
    id: string;
    statusProvider: () => Promise<string>;
  }>;
  closeAgent: (agentId: string) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────

/**
 * agent.spawn - Create a child agent with optional role and history fork
 */
export async function handleAgentSpawn(
  params: AgentSpawnParams,
  ctx: AgentCollabContext
): Promise<{
  status: 'running' | 'failed';
  agent_id: string;
  agent_path: string;
  nickname: string;
}> {
  log.info('agent.spawn called', { params, parentPath: ctx.currentPath.toString() });

  // 1. Reserve spawn slot
  const reservationOpts: SpawnReservationOptions = {
    agentRole: params.role ?? 'default',
    spawnDepth: ctx.currentPath.depth() + 1,
    agentPath: undefined, // Will be set after nickname is determined
  };

  const reservation = ctx.registry.reserveSpawnSlot(reservationOpts);

  try {
    // 2. Derive child path from nickname
    const childName = reservation.reservedNickname.toLowerCase().replace(/\s+/g, '_');
    const childPath = ctx.currentPath.join(childName);

    // 3. Spawn agent (external implementation)
    const { id, statusProvider } = await ctx.spawnAgent(params, childPath);

    // 4. Commit reservation with metadata
    const metadata: Partial<AgentMetadata> = {
      agentId: id,
      agentPath: childPath.toString(),
      agentNickname: reservation.reservedNickname,
      agentRole: params.role,
      spawnDepth: ctx.currentPath.depth() + 1,
      status: 'active' as const,
    };
    reservation.commit(metadata);

    // 5. Update registry with explicit path
    ctx.registry.updateAgentStatus(childPath.toString(), 'active');

    // 6. Start CompletionWatcher (background)
    // Note: In real implementation, import CompletionWatcher dynamically
    // For now, watcher is started by spawnAgent implementation

    log.info('agent.spawn completed', { agentId: id, agentPath: childPath.toString() });

    return {
      status: 'running',
      agent_id: id,
      agent_path: childPath.toString(),
      nickname: reservation.reservedNickname,
    };
  } catch (error) {
    reservation.rollback();
    log.error('agent.spawn failed', error instanceof Error ? error : undefined, { params });
    throw error;
  }
}

/**
 * agent.wait - Wait for child agent to reach final status
 */
export async function handleAgentWait(
  params: AgentWaitParams,
  ctx: AgentCollabContext
): Promise<{
  completed: boolean;
  status?: string;
  message?: string;
}> {
  log.info('agent.wait called', { params });

  const timeoutMs = params.timeout_ms ?? 30000;

  // Find agent by path or id
  let targetPath: AgentPath | undefined;
  if (params.agent_path) {
    targetPath = ctx.currentPath.resolve(params.agent_path);
  } else if (params.agent_id) {
    const agents = ctx.registry.listAgents();
    const agent = agents.find(a => a.agentId === params.agent_id);
    if (agent) {
      targetPath = AgentPath.fromString(agent.agentPath);
    }
  }

  if (!targetPath) {
    log.warn('agent.wait: agent not found', { params });
    return { completed: false, message: 'Agent not found' };
  }

  // Subscribe to mailbox for completion notifications
  // In real implementation: poll mailbox or use subscribeToSeq
  // For now: simple timeout-based check
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = ctx.mailbox.list({ status: 'pending' });
    const completionMsg = pending.find(
      (m) => m.author === targetPath!.toString() && m.triggerTurn === false
    );
    if (completionMsg) {
      log.info('agent.wait: completion detected', { agentPath: targetPath.toString() });
      return { completed: true, status: 'completed', message: completionMsg.content as string };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  log.warn('agent.wait timeout', { params, timeoutMs });
  return { completed: false, message: `Timeout after ${timeoutMs}ms` };
}

/**
 * agent.send_message - Send message to another agent (queue only, no trigger)
 */
export function handleAgentSendMessage(
  params: AgentSendMessageParams,
  ctx: AgentCollabContext
): Promise<{ sent: boolean; seq: number }> {
  log.info('agent.send_message called', { params });

  const recipientPath = ctx.currentPath.resolve(params.recipient);
  const contentStr = typeof params.content === 'string'
    ? params.content
    : JSON.stringify(params.content);

  const result = ctx.mailbox.sendInterAgent({
    author: ctx.currentPath.toString(),
    recipient: recipientPath.toString(),
    content: contentStr,
    triggerTurn: false,
    timestamp: new Date().toISOString(),
  });

  // Handle other_recipients if provided
  if (params.other_recipients) {
    for (const other of params.other_recipients) {
      const otherPath = ctx.currentPath.resolve(other);
      ctx.mailbox.sendInterAgent({
        author: ctx.currentPath.toString(),
        recipient: otherPath.toString(),
        content: contentStr,
        triggerTurn: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return Promise.resolve({ sent: true, seq: result.seq });
}

/**
 * agent.followup_task - Send message with trigger_turn=true (immediate execution)
 */
export function handleAgentFollowupTask(
  params: AgentFollowupTaskParams,
  ctx: AgentCollabContext
): Promise<{ sent: boolean; seq: number; interrupt: boolean }> {
  log.info('agent.followup_task called', { params });

  const recipientPath = ctx.currentPath.resolve(params.recipient);
  const contentStr = typeof params.content === 'string'
    ? params.content
    : JSON.stringify(params.content);

  const result = ctx.mailbox.sendInterAgent({
    author: ctx.currentPath.toString(),
    recipient: recipientPath.toString(),
    content: contentStr,
    triggerTurn: true,
    timestamp: new Date().toISOString(),
  });

  return Promise.resolve({
    sent: true,
    seq: result.seq,
    interrupt: params.interrupt ?? false,
  });
}

/**
 * agent.close - Close an agent by id or path
 */
export async function handleAgentClose(
  params: AgentCloseParams,
  ctx: AgentCollabContext
): Promise<{ closed: boolean; agent_path?: string }> {
  log.info('agent.close called', { params });

  const targetPath = params.agent_path
    ? ctx.currentPath.resolve(params.agent_path)
    : undefined;

  let agentId = params.agent_id;
  let releasePath: string | undefined = targetPath?.toString();

  if (!agentId && targetPath) {
    const metadata = ctx.registry.getAgentByPath(targetPath.toString());
    agentId = metadata?.agentId;
  }

  // If agent_id provided but no path, find path from registry
  if (agentId && !releasePath) {
    const agents = ctx.registry.listAgents();
    const agent = agents.find(a => a.agentId === agentId);
    if (agent) {
      releasePath = agent.agentPath;
    }
  }

  if (!agentId) {
    log.warn('agent.close: agent not found', { params });
    return { closed: false };
  }

  try {
    await ctx.closeAgent(agentId);

    // Release from registry
    if (releasePath) {
      ctx.registry.releaseSpawnedThread(releasePath);
    }

    log.info('agent.close completed', { agentId, agentPath: releasePath });
    return { closed: true, agent_path: releasePath };
  } catch (error) {
    log.error('agent.close failed', error instanceof Error ? error : undefined, { params });
    return { closed: false };
  }
}

/**
 * agent.list - List active agents
 */
export function handleAgentList(
  params: AgentListParams,
  ctx: AgentCollabContext
): { count: number; agents: Array<{ agent_id: string; agent_path: string; nickname: string; role: string }> } {
  log.info('agent.list called', { params });

  const agents = ctx.registry.listAgents(params.path_prefix);

  return {
    count: agents.length,
    agents: agents.map((a) => ({
      agent_id: a.agentId || '',
      agent_path: a.agentPath,
      nickname: a.agentNickname,
      role: a.agentRole ?? 'default',
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────

export const agentCollabToolDefinitions = [
  {
    name: 'agent.spawn',
    description: 'Spawn a child agent to work on a subtask. Optionally fork conversation history.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Task message for the child agent' },
        role: { type: 'string', enum: ['default', 'explorer', 'worker', 'reviewer'], description: 'Role for the child agent' },
        fork_history: { type: 'string', enum: ['FullHistory', 'LastNTurns', 'None'], description: 'History inheritance mode' },
        max_threads: { type: 'number', description: 'Max concurrent threads for child' },
      },
      required: ['message'],
    },
    executionModel: 'execution',
  },
  {
    name: 'agent.wait',
    description: 'Wait for a child agent to complete. Returns completion status or timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to wait for' },
        agent_path: { type: 'string', description: 'Agent path to wait for' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      },
    },
    executionModel: 'execution',
  },
  {
    name: 'agent.send_message',
    description: 'Send a message to another agent. Queues the message without triggering execution.',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Recipient agent path (absolute or relative)' },
        content: { type: 'string', description: 'Message content (string or JSON object)' },
        other_recipients: { type: 'array', items: { type: 'string' }, description: 'Additional recipients for broadcast' },
      },
      required: ['recipient', 'content'],
    },
    executionModel: 'state',
  },
  {
    name: 'agent.followup_task',
    description: 'Send a follow-up task message with trigger_turn=true to immediately execute.',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Recipient agent path' },
        content: { type: 'string', description: 'Task content' },
        interrupt: { type: 'boolean', description: 'Whether to interrupt current task' },
        other_recipients: { type: 'array', items: { type: 'string' }, description: 'Additional recipients' },
      },
      required: ['recipient', 'content'],
    },
    executionModel: 'state',
  },
  {
    name: 'agent.close',
    description: 'Close an agent by ID or path. Releases resources and updates registry.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to close' },
        agent_path: { type: 'string', description: 'Agent path to close' },
      },
    },
    executionModel: 'execution',
  },
  {
    name: 'agent.list',
    description: 'List active agents. Optionally filter by path prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        path_prefix: { type: 'string', description: 'Filter by path prefix' },
      },
    },
    executionModel: 'state',
  },
];
