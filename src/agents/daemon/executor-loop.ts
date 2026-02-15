/**
 * 执行者 ReACT 循环 - 最小闭环实现
 * 
 * 流程：
 * 1. Thought: 分析任务要求，制定执行计划
 * 2. Action: 执行具体操作（文件、命令等）
 * 3. Observation: 获取执行结果
 * 4. 循环直到任务完成
 */

import { Agent } from '../agent.js';
import { BdTools } from '../shared/bd-tools.js';
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

/**
 * 创建带 ReACT 循环的执行者模块
 */
export function createExecutorLoop(
  config: ExecutorLoopConfig
): { agent: Agent; module: OutputModule } {
  
  const systemPrompt = config.systemPrompt ?? `
你是一个任务执行者。你的工作是完成具体的执行任务。

## ReACT 循环

每次循环你需要：
1. **Thought**: 分析任务和已有观察，决定下一步行动
2. **Action**: 执行具体操作
3. **Observation**: 获取结果，更新认知

## 可用行动

- WRITE_FILE: 创建或修改文件
- READ_FILE: 读取文件内容
- RUN_COMMAND: 执行命令
- COMPLETE: 任务完成，返回结果
- FAIL: 任务失败，说明原因

## 输出格式

返回 JSON：
{
  "thought": "分析和决策",
  "action": "WRITE_FILE|READ_FILE|RUN_COMMAND|COMPLETE|FAIL",
  "params": { "path": "文件路径", "content": "内容" },
  "output": "最终输出（COMPLETE时）"
}`;

  const agentConfig = {
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow' as const,
    systemPrompt,
    cwd: config.cwd,
    resumeSession: false, // 每个任务新会话
  };

  const agent = new Agent(agentConfig);
  const bdTools = new BdTools(config.cwd);
  let initialized = false;

  // ReACT 循环核心
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

    while (state.iteration < maxIterations) {
      state.iteration++;
      state.status = 'thinking';

      // === THOUGHT ===
      const statePrompt = `
## 任务
${description}

## 已有观察
${state.observations.length > 0 ? state.observations.map((o, i) => `${i + 1}. ${o}`).join('\n') : '暂无'}

## 当前状态
回合: ${state.iteration}/${maxIterations}

请返回 JSON 格式的决策。`;

      const decision = await agent.execute(statePrompt, {
        onAssistantChunk: (chunk) => process.stdout.write(chunk),
      });

      if (!decision.success) {
        state.status = 'failed';
        state.error = decision.error;
        break;
      }

      // 解析决策
      let action: {
        thought: string;
        action: string;
        params?: Record<string, string>;
        output?: string;
      };

      try {
        const jsonMatch = decision.output.match(/\{[\s\S]*\}/);
        action = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'FAIL', thought: 'Parse error' };
      } catch {
        action = { action: 'FAIL', thought: 'Invalid JSON' };
      }

      console.log(`[Executor ${config.id}] Round ${state.iteration}: ${action.action}`);

      // === ACTION ===
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
              state.observations.push(`文件已创建: ${action.params.path}`);
              
              if (bdTaskId) {
                await bdTools.addComment(bdTaskId, `创建文件: ${action.params.path}`);
              }
            } catch (e) {
              state.observations.push(`文件创建失败: ${e}`);
            }
          }
          break;
        }

        case 'READ_FILE': {
          if (action.params?.path) {
            const fs = await import('fs');
            const path = await import('path');
            const filePath = path.resolve(config.cwd || process.cwd(), action.params.path);
            
            try {
              const content = await fs.promises.readFile(filePath, 'utf-8');
              state.observations.push(`文件内容:\n${content.substring(0, 1000)}...`);
            } catch (e) {
              state.observations.push(`读取失败: ${e}`);
            }
          }
          break;
        }

        case 'RUN_COMMAND': {
          if (action.params?.command) {
            const { exec } = await import('child_process');
            const result = await new Promise<string>((resolve) => {
              exec(action.params!.command, { cwd: config.cwd }, (err, stdout, stderr) => {
                if (err) resolve(`错误: ${stderr || err.message}`);
                else resolve(stdout || '命令执行成功');
              });
            });
            state.observations.push(`命令输出:\n${result}`);
          }
          break;
        }

        case 'COMPLETE': {
          state.status = 'completed';
          state.result = action.output || action.thought;
          
          if (bdTaskId) {
            await bdTools.closeTask(bdTaskId, '执行完成', [
              { type: 'result', content: state.result },
            ]);
          }
          
          return { success: true, output: state.result };
        }

        case 'FAIL': {
          state.status = 'failed';
          state.error = action.thought;
          
          if (bdTaskId) {
            await bdTools.updateStatus(bdTaskId, 'blocked');
            await bdTools.addComment(bdTaskId, `执行失败: ${action.thought}`);
          }
          
          return { success: false, error: state.error };
        }
      }

      // === OBSERVATION ===
      state.status = 'observing';
    }

    // 超出最大迭代
    state.status = 'failed';
    state.error = 'Exceeded maximum iterations';
    
    if (bdTaskId) {
      await bdTools.updateStatus(bdTaskId, 'blocked');
      await bdTools.addComment(bdTaskId, `执行超时: 超过最大迭代次数`);
    }
    
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
      await agent.initialize();
      initialized = true;
    },

    destroy: async () => {
      await agent.disconnect();
      initialized = false;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      if (!initialized) {
        await agent.initialize();
        initialized = true;
      }

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
