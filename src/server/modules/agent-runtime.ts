import type { Express } from 'express';
import { recommendLoopTemplates } from '../../orchestration/loop/loop-template-registry.js';
import { isObjectRecord } from '../common/object.js';
import type { AgentCapabilityLayer, AgentRuntimeDeps } from './agent-runtime/types.js';
import { dispatchTaskToAgent } from './agent-runtime/dispatch.js';
import { controlAgentRuntime } from './agent-runtime/control.js';
import { parseAskToolInput, runBlockingAsk } from './agent-runtime/ask.js';
import {
  parseAgentControlToolInput,
  parseAgentDeployToolInput,
  parseAgentDispatchToolInput,
} from './agent-runtime/parsers.js';

function resolveAgentCapabilityLayer(value: unknown): AgentCapabilityLayer {
  if (typeof value !== 'string') return 'summary';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'execution') return 'execution';
  if (normalized === 'governance') return 'governance';
  if (normalized === 'full') return 'full';
  return 'summary';
}

export function registerAgentRuntimeTools(deps: AgentRuntimeDeps): string[] {
  const loaded: string[] = [];

  deps.runtime.registerTool({
    name: 'agent.list',
    description:
      'List available agents with layered capability exposure. layer: summary|execution|governance|full.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: ['summary', 'execution', 'governance', 'full'] },
      },
      additionalProperties: false,
    },
    handler: async (input: unknown): Promise<unknown> => {
      const layer = resolveAgentCapabilityLayer(isObjectRecord(input) ? input.layer : undefined);
      return deps.agentRuntimeBlock.execute('catalog', { layer });
    },
  });
  loaded.push('agent.list');

  deps.runtime.registerTool({
    name: 'agent.capabilities',
    description:
      'Get capability details for one target agent. Supports layered exposure with layer=summary|execution|governance|full.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        layer: { type: 'string', enum: ['summary', 'execution', 'governance', 'full'] },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
    handler: async (input: unknown): Promise<unknown> => {
      if (!isObjectRecord(input)) {
        throw new Error('agent.capabilities input must be object');
      }
      const agentId = typeof input.agent_id === 'string'
        ? input.agent_id.trim()
        : typeof input.agentId === 'string'
          ? input.agentId.trim()
          : '';
      if (agentId.length === 0) {
        throw new Error('agent.capabilities agent_id is required');
      }
      const layer = resolveAgentCapabilityLayer(input.layer);
      return deps.agentRuntimeBlock.execute('capabilities', { agentId, layer });
    },
  });
  loaded.push('agent.capabilities');

  deps.runtime.registerTool({
    name: 'agent.deploy',
    description:
      'Activate/start an agent target in resource pool. Use before dispatch when target is not started.',
    inputSchema: {
      type: 'object',
      properties: {
        target_agent_id: { type: 'string' },
        target_implementation_id: { type: 'string' },
        provider: { type: 'string' },
        instance_count: { type: 'number' },
        scope: { type: 'string', enum: ['session', 'global'] },
        launch_mode: { type: 'string', enum: ['manual', 'orchestrator'] },
        session_id: { type: 'string' },
        config: { type: 'object' },
      },
      additionalProperties: true,
    },
    handler: async (input: unknown): Promise<unknown> => {
      const deployInput = parseAgentDeployToolInput(input);
      return deps.agentRuntimeBlock.execute('deploy', deployInput);
    },
  });
  loaded.push('agent.deploy');

  deps.runtime.registerTool({
    name: 'agent.dispatch',
    description:
      'Dispatch a task to another agent/module through standard runtime routing. Required: target_agent_id + task.',
    inputSchema: {
      type: 'object',
      properties: {
        source_agent_id: { type: 'string' },
        target_agent_id: { type: 'string' },
        task: {},
        session_id: { type: 'string' },
        workflow_id: { type: 'string' },
        blocking: { type: 'boolean' },
        queue_on_busy: { type: 'boolean' },
        max_queue_wait_ms: { type: 'number' },
        assignment: { type: 'object' },
        metadata: { type: 'object' },
      },
      required: ['target_agent_id', 'task'],
      additionalProperties: true,
    },
    handler: async (input: unknown): Promise<unknown> => {
      const dispatchInput = parseAgentDispatchToolInput(input, deps);
      return dispatchTaskToAgent(deps, dispatchInput);
    },
  });
  loaded.push('agent.dispatch');

  deps.runtime.registerTool({
    name: 'agent.control',
    description:
      'Control or query runtime state. action: status|pause|resume|interrupt|cancel. Use session_id/workflow_id as scope.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'pause', 'resume', 'interrupt', 'cancel'] },
        target_agent_id: { type: 'string' },
        session_id: { type: 'string' },
        workflow_id: { type: 'string' },
        provider_id: { type: 'string' },
        hard: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: true,
    },
    handler: async (input: unknown): Promise<unknown> => {
      const controlInput = parseAgentControlToolInput(input);
      return controlAgentRuntime(deps, controlInput);
    },
  });
  loaded.push('agent.control');

  deps.runtime.registerTool({
    name: 'orchestrator.loop_templates',
    description:
      'Suggest loop templates and blocking split for current task set. Templates: epic_planning|parallel_execution|review_retry|search_evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              blockedBy: { type: 'array', items: { type: 'string' } },
            },
            required: ['description'],
            additionalProperties: true,
          },
        },
        context_consumption: { type: 'string', enum: ['low', 'medium', 'high'] },
        requires_evidence: { type: 'boolean' },
      },
      additionalProperties: true,
    },
    handler: async (input: unknown): Promise<unknown> => {
      if (!isObjectRecord(input)) {
        throw new Error('orchestrator.loop_templates input must be object');
      }
      const contextConsumption = typeof input.context_consumption === 'string'
        ? input.context_consumption
        : typeof input.contextConsumption === 'string'
          ? input.contextConsumption
          : undefined;
      const tasksRaw = Array.isArray(input.tasks)
        ? input.tasks
        : undefined;
      const taskItems = tasksRaw?.map((item) => {
        const record = isObjectRecord(item) ? item : {};
        return {
          ...(typeof record.id === 'string' ? { id: record.id } : {}),
          description: typeof record.description === 'string'
            ? record.description
            : typeof record.task === 'string'
              ? record.task
              : '',
          ...(Array.isArray(record.blockedBy) ? { blockedBy: record.blockedBy } : Array.isArray(record.blocked_by) ? { blockedBy: record.blocked_by } : {}),
        };
      }).filter((item) => typeof item.description === 'string' && item.description.trim().length > 0);

      return recommendLoopTemplates({
        ...(typeof input.task === 'string' && input.task.trim().length > 0 ? { task: input.task.trim() } : {}),
        ...(taskItems && taskItems.length > 0 ? { tasks: taskItems } : {}),
        ...(contextConsumption === 'low' || contextConsumption === 'medium' || contextConsumption === 'high'
          ? { contextConsumption }
          : {}),
        ...(input.requires_evidence === true || input.requiresEvidence === true ? { requiresEvidence: true } : {}),
      });
    },
  });
  loaded.push('orchestrator.loop_templates');

  deps.runtime.registerTool({
    name: 'user.ask',
    description:
      'Ask user for clarification/decision in blocking mode. Returns when answer is provided or timeout is reached.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        context: { type: 'string' },
        agent_id: { type: 'string' },
        session_id: { type: 'string' },
        workflow_id: { type: 'string' },
        epic_id: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['question'],
      additionalProperties: true,
    },
    handler: async (input: unknown): Promise<unknown> => {
      const askInput = parseAskToolInput(input);
      return runBlockingAsk(deps, askInput);
    },
  });
  loaded.push('user.ask');

  // Session switching tool
  deps.runtime.registerTool({
    name: 'session.switch',
    description: 'Switch to a different session within the current project',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        target_agent_id: { type: 'string' }
      },
      required: ['session_id'],
      additionalProperties: false
    },
    handler: async (input: unknown): Promise<unknown> => {
      if (!isObjectRecord(input)) {
        throw new Error('session.switch input must be object');
      }

      const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : '';
      if (sessionId.length === 0) {
        throw new Error('session.switch session_id is required');
      }

      const currentAgentId = deps.primaryOrchestratorAgentId;
      const targetAgentId = typeof input.target_agent_id === 'string' ? input.target_agent_id.trim() : currentAgentId;

      if (currentAgentId !== 'finger-system-agent' && targetAgentId !== currentAgentId) {
        throw new Error(`Agent ${currentAgentId} can only switch its own sessions`);
      }

      const success = deps.runtime.setCurrentSession(sessionId);
      if (!success) {
        throw new Error(`Failed to switch to session: ${sessionId}`);
      }

      return { success: true, session_id: sessionId, agent_id: targetAgentId };
    }
  });
  loaded.push('session.switch');

  // Session list tool
  deps.runtime.registerTool({
    name: 'session.list',
    description: 'List all sessions in the current project',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' }
      },
      additionalProperties: false
    },
    handler: async (input: unknown): Promise<unknown> => {
      const limit = isObjectRecord(input) && typeof input.limit === 'number' ? input.limit : undefined;
      const sessions = deps.runtime.listSessions();
      const result = limit && limit > 0 ? sessions.slice(0, limit) : sessions;

      return {
        sessions: result.map(s => ({
          session_id: s.id,
          created_at: s.createdAt,
          last_accessed_at: s.updatedAt,
          message_count: s.messageCount
        })),
        total: sessions.length
      };
    }
  });
  loaded.push('session.list');


  // CommandHub exec tool - shared command processing
  deps.runtime.registerTool({
    name: 'command.exec',
    description: 'Execute <##...##> commands via shared CommandHub (MessageHub/System Agent/CLI unified).',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Command string, e.g. <##@system:provider:list##>' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    handler: async (input: unknown): Promise<unknown> => {
      if (!isObjectRecord(input) || typeof input.input !== 'string') {
        throw new Error('command.exec input must be { input: string }');
      }
      const { parseCommands, getCommandHub } = await import('../../blocks/command-hub/index.js');
      const parsed = parseCommands(input.input);
      if (parsed.commands.length === 0) {
        return { success: false, output: '未检测到命令' };
      }
      const executor = getCommandHub();
      const result = await executor.execute(parsed.commands[0], {
        channelId: 'agent',
        configPath: `${process.env.HOME || ''}/.finger/config/config.json`,
        updateContext: (id, mode, agentId) => {
          const { ChannelContextManager } = require('../../orchestration/channel-context-manager.js');
          const ctxMgr = ChannelContextManager.getInstance();
          ctxMgr.updateContext(id, mode, agentId);
        }
      });
      return result;
    }
  });
  loaded.push('command.exec');
  return loaded;
}

export function registerAgentRuntimeRoutes(app: Express, deps: AgentRuntimeDeps): void {
  app.get('/api/v1/agents/runtime-view', (_req, res) => {
    void deps.agentRuntimeBlock.execute('runtime_view', {}).then((snapshot) => {
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        ...(snapshot as Record<string, unknown>),
      });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    });
  });
}

