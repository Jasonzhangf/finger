/**
 * 执行者 ReACT 循环 - 最小闭环实现
 */

import { Agent } from '../agent.js';
import { BdTools } from '../shared/bd-tools.js';
import { createSnapshotLogger, SnapshotLogger } from '../shared/snapshot-logger.js';
import type { OutputModule } from '../../orchestration/module-registry.js';

export interface ExecutorLoopConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
  maxIterations?: number;
}

export interface ExecutionState {
  taskId: string;
  description: string;
  status: 'thinking' | 'acting' | 'observing' | 'completed' | 'failed';
  iteration: number;
  observations: string[];
  result?: string;
  error?: string;
}

export function createExecutorLoop(config: ExecutorLoopConfig): { agent: Agent; module: OutputModule } {
  const systemPrompt = config.systemPrompt ?? `
你是一个任务执行者。你的工作是完成具体的执行任务。

## ReACT 循环

每次循环你需要：
1. Thought: 分析任务和已有观察，决定下一步行动
2. Action: 执行具体操作
3. Observation: 获取结果

## 可用行动

- WRITE_FILE: 创建文件，参数 { path: "文件路径", content: "内容" }
- COMPLETE: 任务完成，参数 { output: "完成说明" }
- FAIL: 任务失败，参数 { reason: "失败原因" }

## 输出格式（必须严格遵循）

只输出 JSON，不要其他文字：
{"thought": "分析", "action": "WRITE_FILE|COMPLETE|FAIL", "params": {"path": "xxx", "content": "xxx"}}

示例：
{"thought": "需要创建文件", "action": "WRITE_FILE", "params": {"path": "/tmp/test.txt", "content": "Hello"}}
{"thought": "任务完成", "action": "COMPLETE", "params": {"output": "文件已创建"}}`;

  const agent = new Agent({
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt,
    cwd: config.cwd,
    resumeSession: false,
  });

  const bdTools = new BdTools(config.cwd);
  const logger: SnapshotLogger = createSnapshotLogger(config.id);
  let initialized = false;

  async function reactLoop(
    taskId: string,
    description: string,
    bdTaskId?: string
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const state: ExecutionState = {
      taskId,
      description,
      status: 'thinking',
      iteration: 0,
      observations: [],
    };

    const maxIterations = config.maxIterations ?? 5;
    const startTime = Date.now();

    console.log(`[ExecutorLoop ${config.id}] Starting task: ${taskId}`);
    
    // Ensure agent is initialized before executing
    if (!initialized) {
      console.log(`[ExecutorLoop ${config.id}] Initializing agent...`);
      try {
        const status = await agent.initialize();
        console.log(`[ExecutorLoop ${config.id}] Agent initialized, connected: ${status.connected}`);
        initialized = true;
      } catch (initErr) {
        const errorMsg = initErr instanceof Error ? initErr.message : String(initErr);
        console.error(`[ExecutorLoop ${config.id}] Failed to initialize agent:`, errorMsg);
        return { success: false, error: `Agent initialization failed: ${errorMsg}` };
      }
    }

    logger.log({
      timestamp: new Date().toISOString(),
      iteration: 0,
      phase: 'start',
      input: { taskId, description, bdTaskId },
      output: null,
    });

    while (state.iteration < maxIterations) {
      state.iteration++;
      state.status = 'thinking';
      const iterStart = Date.now();

      // THOUGHT
      const statePrompt = `## 任务
${description}

## 已有观察
${state.observations.length > 0 ? state.observations.map((o, i) => `${i + 1}. ${o}`).join('\n') : '暂无'}

## 当前状态
回合: ${state.iteration}/${maxIterations}

请立即输出 JSON 格式的决策（只输出 JSON，不要其他文字）：`;

      console.log(`[ExecutorLoop ${config.id}] Round ${state.iteration}: thinking...`);
      
      let decision;
      try {
        const agentStatus = agent.getStatus();
        console.log(`[ExecutorLoop ${config.id}] Agent status before execute: connected=${agentStatus.connected}, running=${agentStatus.running}`);
        
        decision = await agent.execute(statePrompt, {
          onAssistantChunk: (chunk) => process.stdout.write(chunk),
        });
      } catch (execErr) {
        const errorMsg = execErr instanceof Error ? execErr.message : String(execErr);
        console.error(`[ExecutorLoop ${config.id}] Execute error:`, errorMsg);
        
        // Try to reinitialize and retry once
        console.log(`[ExecutorLoop ${config.id}] Attempting to reinitialize...`);
        try {
          await agent.initialize();
          decision = await agent.execute(statePrompt);
        } catch (retryErr) {
          return { success: false, error: `Execution failed after retry: ${retryErr}` };
        }
      }

      const thoughtDuration = Date.now() - iterStart;

      if (!decision.success) {
        console.error(`[ExecutorLoop ${config.id}] Decision failed:`, decision.error);
        state.status = 'failed';
        state.error = decision.error;
        
        logger.log({
          timestamp: new Date().toISOString(),
          iteration: state.iteration,
          phase: 'decision_failed',
          input: statePrompt,
          output: decision,
          duration: thoughtDuration,
          error: decision.error,
        });
        break;
      }

      // Log AI response
      logger.log({
        timestamp: new Date().toISOString(),
        iteration: state.iteration,
        phase: 'thought',
        input: statePrompt,
        output: decision.output,
        duration: thoughtDuration,
      });

      // Parse action
      let action: { thought: string; action: string; params?: Record<string, string> };
      try {
        const jsonMatch = decision.output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in response');
        }
        action = JSON.parse(jsonMatch[0]);
        console.log(`[ExecutorLoop ${config.id}] Round ${state.iteration}: action=${action.action}`);
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : 'Parse error';
        console.error(`[ExecutorLoop ${config.id}] Parse error:`, errorMsg);
        console.error(`[ExecutorLoop ${config.id}] Raw output:`, decision.output.substring(0, 500));
        
        logger.log({
          timestamp: new Date().toISOString(),
          iteration: state.iteration,
          phase: 'parse_error',
          input: decision.output,
          output: null,
          error: errorMsg,
        });
        
        // Try to continue with FAIL action
        action = { action: 'FAIL', thought: `Parse error: ${errorMsg}`, params: { reason: errorMsg } };
      }

      // ACTION
      state.status = 'acting';

      switch (action.action) {
        case 'WRITE_FILE': {
          if (action.params?.path && action.params?.content) {
            const fs = await import('fs');
            const path = await import('path');
            const filePath = path.resolve(config.cwd || process.cwd(), action.params.path);

            try {
              await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
              await fs.promises.writeFile(filePath, action.params.content, 'utf-8');
              const obs = `文件已创建: ${action.params.path}`;
              state.observations.push(obs);
              console.log(`[ExecutorLoop ${config.id}] ${obs}`);
              
              if (bdTaskId) {
                await bdTools.addComment(bdTaskId, obs);
              }
            } catch (e) {
              const obs = `文件创建失败: ${e}`;
              state.observations.push(obs);
              console.error(`[ExecutorLoop ${config.id}] ${obs}`);
            }
          }
          break;
        }

        case 'COMPLETE': {
          state.status = 'completed';
          state.result = action.params?.output || action.thought || 'Task completed';

          logger.log({
            timestamp: new Date().toISOString(),
            iteration: state.iteration,
            phase: 'complete',
            input: null,
            output: { result: state.result },
            duration: Date.now() - startTime,
          });

          if (bdTaskId) {
            await bdTools.closeTask(bdTaskId, '执行完成', [
              { type: 'result', content: state.result },
            ]);
          }

          console.log(`[ExecutorLoop ${config.id}] Task completed: ${state.result}`);
          return { success: true, output: state.result };
        }

        case 'FAIL': {
          state.status = 'failed';
          state.error = action.params?.reason || action.thought || 'Task failed';

          logger.log({
            timestamp: new Date().toISOString(),
            iteration: state.iteration,
            phase: 'fail',
            input: null,
            output: { error: state.error },
            duration: Date.now() - startTime,
          });

          if (bdTaskId) {
            await bdTools.updateStatus(bdTaskId, 'blocked');
            await bdTools.addComment(bdTaskId, `执行失败: ${state.error}`);
          }

          console.log(`[ExecutorLoop ${config.id}] Task failed: ${state.error}`);
          return { success: false, error: state.error };
        }

        default:
          console.warn(`[ExecutorLoop ${config.id}] Unknown action: ${action.action}`);
          state.observations.push(`未知行动: ${action.action}`);
      }

      // OBSERVATION
      state.status = 'observing';
    }

    // Exceeded iterations
    state.status = 'failed';
    state.error = `Exceeded maximum iterations (${maxIterations})`;

    logger.log({
      timestamp: new Date().toISOString(),
      iteration: state.iteration,
      phase: 'timeout',
      input: null,
      output: { observations: state.observations },
      duration: Date.now() - startTime,
      error: state.error,
    });

    if (bdTaskId) {
      await bdTools.updateStatus(bdTaskId, 'blocked');
      await bdTools.addComment(bdTaskId, `执行超时: ${state.error}`);
    }

    console.error(`[ExecutorLoop ${config.id}] ${state.error}`);
    return { success: false, error: state.error };
  }

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow', type: 'executor-loop' },

    initialize: async () => {
      if (initialized) return;
      console.log(`[ExecutorLoop ${config.id}] Initializing...`);
      try {
        const status = await agent.initialize();
        console.log(`[ExecutorLoop ${config.id}] Initialized, connected: ${status.connected}, session: ${status.sessionId}`);
        initialized = true;
      } catch (err) {
        console.error(`[ExecutorLoop ${config.id}] Initialization failed:`, err);
        throw err;
      }
    },

    destroy: async () => {
      await agent.disconnect();
      initialized = false;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      const msg = message as Record<string, unknown>;
      const taskId = String(msg.taskId || 'task-' + Date.now());
      const description = String(msg.description || msg.content || '');
      const bdTaskId = msg.bdTaskId ? String(msg.bdTaskId) : undefined;

      if (!description) {
        const error = { success: false, error: 'No task description provided' };
        if (callback) callback(error);
        return error;
      }

      try {
        const result = await reactLoop(taskId, description, bdTaskId);
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
