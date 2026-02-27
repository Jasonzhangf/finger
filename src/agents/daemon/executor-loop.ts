/**
 * 执行者 ReACT 循环 - 基于通用 ReACT Loop
 * 无硬编码 switch/case
 */

import { Agent } from '../agent.js';
import { BdTools } from '../shared/bd-tools.js';
import { createSnapshotLogger, SnapshotLogger } from '../shared/snapshot-logger.js';
import type { OutputModule } from '../../orchestration/module-registry.js';
import {
  ActionRegistry,
  createExecutorActions,
  type ActionResult,
} from '../core/action-registry-simple.js';
import { buildAgentContext, generateDynamicSystemPrompt } from '../../orchestration/agent-context.js';
import { globalEventBus } from '../../runtime/event-bus.js';
import {
  ReActLoop,
  type LoopConfig,
  type ReActResult,
  type ReActState,
} from '../runtime/react-loop.js';

export interface ExecutorLoopConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
  maxIterations?: number;
}

interface ExecutorState extends ReActState {
  taskId: string;
  description: string;
  bdTaskId?: string;
  observations: string[];
  epicId?: string;
  executionLoopId?: string;
}

export function createExecutorLoop(config: ExecutorLoopConfig): { agent: Agent; module: OutputModule } {
  const agent = new Agent({
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt: config.systemPrompt,
    cwd: config.cwd,
    resumeSession: false,
  });

  const bdTools = new BdTools(config.cwd);
  const logger: SnapshotLogger = createSnapshotLogger(config.id);
  let initialized = false;
  let initPromise: Promise<void> | null = null;

  const actionRegistry = new ActionRegistry();
  const actions = createExecutorActions(config.cwd);

  const ensureConnected = async (): Promise<void> => {
    if (!initialized) {
      if (!initPromise) {
        initPromise = agent.initialize().then(() => {
          initialized = true;
        });
      }
      await initPromise;
    }
  };

  for (const action of actions) {
    const originalHandler = action.handler;
    action.handler = async (params, context): Promise<ActionResult> => {
      const loopContext = context as { state?: ExecutorState };
      const state = loopContext.state;

      const result = await originalHandler(params, context);

      if (state && result.observation) {
        state.observations.push(result.observation);
      }

      // Emit loop node update event for UI
      if (state?.epicId && state.executionLoopId && state.taskId) {
        globalEventBus.emit({
          type: 'loop.node.updated',
          sessionId: state.epicId,
          timestamp: new Date().toISOString(),
          epicId: state.epicId,
          loopId: state.executionLoopId,
          nodeId: `${state.taskId}-${Date.now()}`,
          payload: {
            node: {
              id: `${state.taskId}-${Date.now()}`,
              type: 'exec' as const,
              status: result.success ? 'done' : 'failed',
              title: state.taskId,
              text: result.observation?.substring(0, 100) || (result.error || 'executing'),
              agentId: config.id,
              timestamp: new Date().toISOString(),
            },
            previousStatus: 'running',
          },
        });
      }

      if (state?.bdTaskId) {
        if (result.success && result.stopReason === 'complete') {
          await bdTools.closeTask(state.bdTaskId, '执行完成', [
            { type: 'result', content: result.observation },
          ]);
        } else if (!result.success && result.stopReason === 'fail') {
          await bdTools.updateStatus(state.bdTaskId, 'blocked');
          await bdTools.addComment(state.bdTaskId, `执行失败：${result.error || result.observation}`);
        } else if (result.observation) {
          await bdTools.addComment(state.bdTaskId, result.observation);
        }
      }

      return result;
    };

    actionRegistry.register(action);
  }

  async function runTask(
    taskId: string,
    description: string,
    bdTaskId?: string,
    epicId?: string,
    executionLoopId?: string
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    await ensureConnected();

    const status = agent.getStatus();
    console.log(`[executor-loop] Agent status after initialize: connected=${status.connected}, sessionId=${status.sessionId}`);

    const loopConfig: LoopConfig = {
      planner: {
        agent,
        actionRegistry,
        freshSessionPerRound: true,
      },
      stopConditions: {
        completeActions: ['COMPLETE'],
        failActions: ['FAIL'],
        maxRounds: config.maxIterations ?? 5,
        onConvergence: true,
        onStuck: 3,
        maxRejections: 4,
      },
      formatFix: {
        maxRetries: 10,
        schema: {
          type: 'object',
          required: ['thought', 'action', 'params'],
          properties: {
            thought: { type: 'string' },
            action: { type: 'string' },
            params: { type: 'object' },
            expectedOutcome: { type: 'string' },
            risk: { type: 'string' },
          },
        },
      },
      snapshotLogger: logger,
      agentId: config.id,
    };

    const loop = new ReActLoop(loopConfig, description);
    (loop as unknown as { state: ExecutorState }).state = {
      task: description,
      iterations: [],
      convergence: {
        rejectionStreak: 0,
        sameRejectionReason: '',
        stuckCount: 0,
      },
      taskId,
      description,
      bdTaskId,
      observations: [],
      epicId,
      executionLoopId,
    };

    try {
      const result: ReActResult = await loop.run();
      return {
        success: result.success,
        output: result.finalObservation,
        error: result.finalError,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow', type: 'executor-loop' },

    initialize: async () => {
      await ensureConnected();
    },

    destroy: async () => {
      await agent.disconnect();
      initialized = false;
      initPromise = null;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      const msg = message as Record<string, unknown>;
      const taskId = String(msg.taskId || `task-${Date.now()}`);
      const description = String(msg.description || msg.content || '');
      const bdTaskId = msg.bdTaskId ? String(msg.bdTaskId) : undefined;
      const context = msg.context as Record<string, unknown> | undefined;

      if (!description) {
        const error = { success: false, error: 'No task description provided' };
        if (callback) callback(error);
        return error;
      }

      const taskContext = buildAgentContext({
        taskId,
        taskDescription: description,
        bdTaskId,
        orchestratorNote: context?.orchestratorNote as string,
      });
      const dynamicPrompt = generateDynamicSystemPrompt(config.systemPrompt || '', taskContext);
      agent.updateSystemPrompt(dynamicPrompt);

      try {
        const result = await runTask(taskId, description, bdTaskId);
        if (callback) callback(result);
        return result;
      } catch (err) {
        const error = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        if (callback) callback(error);
        return error;
      }
    },
  };

  return { agent, module };
}
