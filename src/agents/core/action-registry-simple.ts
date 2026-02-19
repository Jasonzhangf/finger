// 简化版 Action Registry - 统一接口

import { performWebSearch } from '../../server/tools/web-search.js';

export interface ActionResult {
  success: boolean;
  observation: string;
  data?: unknown;
  error?: string;
  shouldStop?: boolean;
  stopReason?: 'complete' | 'fail' | 'escalate';
}

export interface ActionDefinition {
  name: string;
  description: string;
  paramsSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>, context: unknown) => Promise<ActionResult>;
  riskLevel?: 'low' | 'medium' | 'high';
}

export class ActionRegistry {
  private actions: Map<string, ActionDefinition> = new Map();

  register(action: ActionDefinition): void {
    this.actions.set(action.name, action);
  }

  get(name: string): unknown {
    return this.actions.get(name);
  }

  list(): Array<{ name: string; description: string; paramsSchema: Record<string, unknown> }> {
    return Array.from(this.actions.values());
  }

  async execute(name: string, params: Record<string, unknown>, _context: unknown): Promise<ActionResult> {
    const action = this.actions.get(name);
    if (!action) {
      return {
        success: false,
        observation: `Unknown action: ${name}`,
        error: `Action ${name} not found`,
      };
    }
    try {
      return await action.handler(params, _context);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        observation: `Execution error: ${errorMsg}`,
        error: errorMsg,
      };
    }
  }
}

// 创建执行者 Actions
export function createExecutorActions(cwd?: string): ActionDefinition[] {
  return [
    {
      name: 'WEB_SEARCH',
      description: '进行网络搜索并返回结构化结果',
      paramsSchema: {
        query: { type: 'string', required: true },
      },
      riskLevel: 'low',
      handler: async (params) => {
        const query = String(params.query || '').trim();

        if (!query) {
          return { success: false, observation: '搜索关键词为空', error: 'Empty query' };
        }

        const result = await performWebSearch(query, { maxResults: 5, timeoutMs: 15000 });
        if (!result.success) {
          return {
            success: false,
            observation: `搜索失败: ${result.error || 'unknown error'}`,
            error: result.error || 'search failed',
            data: {
              query,
              provider: result.provider,
              attemptedProviders: result.attemptedProviders,
            },
          };
        }

        if (result.results.length === 0) {
          return {
            success: false,
            observation: `搜索完成，但未提取到结构化结果: ${query}`,
            error: 'No structured search results',
            data: {
              query,
              provider: result.provider,
              attemptedProviders: result.attemptedProviders,
              results: [] as string[],
            },
          };
        }

        const formatted = result.results.map(item => `- ${item.title} | ${item.url}`);
        return {
          success: true,
          observation: `搜索结果 (${query}):\n${formatted.join('\n')}`,
          data: {
            query,
            provider: result.provider,
            attemptedProviders: result.attemptedProviders,
            results: result.results,
          },
        };
      },
    },
    {
      name: 'FETCH_URL',
      description: '抓取网页内容',
      paramsSchema: {
        url: { type: 'string', required: true },
      },
      riskLevel: 'low',
      handler: async (params) => {
        const target = String(params.url || '').trim();
        if (!target) {
          return { success: false, observation: 'URL 不能为空', error: 'Empty url' };
        }

        const response = await fetch(target);
        const content = await response.text();
        return {
          success: true,
          observation: `网页获取成功: ${target} (status=${response.status}, length=${content.length})`,
          data: { url: target, status: response.status, content },
        };
      },
    },
    {
      name: 'READ_FILE',
      description: '读取文件内容',
      paramsSchema: {
        path: { type: 'string', required: true },
      },
      riskLevel: 'low',
      handler: async (params) => {
        const fs = await import('fs');
        const path = await import('path');
        // Accept legacy/alternate key names produced by LLMs.
        const rawPath =
          params.path ||
          params.filePath ||
          params.filename ||
          params.file ||
          params.absolute_path ||
          params.absolutePath;
        const inputPath = String(rawPath || '').trim();
        if (!inputPath) {
          return { success: false, observation: '文件路径不能为空', error: 'Empty path' };
        }

        const filePath = path.resolve(cwd || process.cwd(), inputPath);
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const preview = content.length > 500 ? `${content.slice(0, 500)}...` : content;
          return {
            success: true,
            observation: `文件读取成功: ${inputPath}\n${preview}`,
            data: { path: inputPath, content },
          };
        } catch (e) {
          return {
            success: false,
            observation: `文件读取失败: ${e}`,
            error: String(e),
          };
        }
      },
    },
    {
      name: 'WRITE_FILE',
      description: '创建或覆盖文件',
      paramsSchema: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      riskLevel: 'medium',
      handler: async (params) => {
        const fs = await import('fs');
        const path = await import('path');
        const rawPath =
          params.path ||
          params.filePath ||
          params.filename ||
          params.file ||
          params.absolute_path ||
          params.absolutePath ||
          params.saveTo;
        const inputPath = String(rawPath || '').trim();
        if (!inputPath) {
          return { success: false, observation: '文件路径不能为空', error: 'Empty path' };
        }
        const filePath = path.resolve(cwd || process.cwd(), inputPath);
        const rawContent = params.content ?? params.text ?? params.body;
        const content = String(rawContent || '');
        if (!content) {
          return { success: false, observation: '文件内容不能为空', error: 'Empty content' };
        }
        try {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.writeFile(filePath, content, 'utf-8');
          return { success: true, observation: `文件已创建: ${inputPath}` };
        } catch (e) {
          return { success: false, observation: `文件创建失败: ${e}`, error: String(e) };
        }
      },
    },
    {
      name: 'SHELL_EXEC',
      description: '执行 shell 命令',
      paramsSchema: { command: { type: 'string', required: true } },
      riskLevel: 'high',
      handler: async (params) => {
        const { exec } = await import('child_process');
        const maxObservationLength = 2000;
        const trimOutput = (value: string): string => {
          if (value.length <= maxObservationLength) return value;
          return `${value.slice(0, maxObservationLength)}\n...[output truncated]`;
        };
        return new Promise((resolve) => {
          exec(params.command as string, { cwd }, (error, stdout, stderr) => {
            if (error) {
              resolve({
                success: false,
                observation: trimOutput(stderr || error.message),
                error: error.message,
              });
            } else {
              resolve({ success: true, observation: trimOutput(stdout || '命令执行成功') });
            }
          });
        });
      },
    },
    {
      name: 'COMPLETE',
      description: '任务完成',
      paramsSchema: { output: { type: 'string', required: false }, summary: { type: 'string', required: false } },
      handler: async (params) => ({
        success: true,
        observation: `任务完成: ${params.output}`,
        shouldStop: true,
        stopReason: 'complete',
      }),
    },
    {
      name: 'FAIL',
      description: '任务失败',
      paramsSchema: { reason: { type: 'string', required: true } },
      handler: async (params) => ({
        success: false,
        observation: `任务失败: ${params.reason}`,
        error: params.reason as string,
        shouldStop: true,
        stopReason: 'fail',
      }),
    },
  ];
}

// 创建编排者 Actions
export function createOrchestratorActions(): ActionDefinition[] {
  return [
    {
      name: 'HIGH_DESIGN',
      description: '进行概要设计：输出高层架构、技术选型、模块划分',
      paramsSchema: {
        architecture: { type: 'string', required: true, description: '高层架构描述' },
        techStack: { type: 'array', required: true, description: '技术选型列表' },
        modules: { type: 'array', required: true, description: '模块划分列表' },
        rationale: { type: 'string', required: false, description: '设计理由' },
      },
      handler: async (params) => ({
        success: true,
        observation: `概要设计完成：架构=${params.architecture}, 模块数=${(params.modules as unknown[]).length}`,
        data: { phase: 'high_design', ...params },
      }),
    },
    {
      name: 'DETAIL_DESIGN',
      description: '进行详细设计：输出接口定义、数据结构、实现细节',
      paramsSchema: {
        interfaces: { type: 'array', required: true, description: '接口定义列表' },
        dataModels: { type: 'array', required: true, description: '数据模型列表' },
        implementation: { type: 'string', required: true, description: '实现细节' },
      },
      handler: async (params) => ({
        success: true,
        observation: `详细设计完成：接口数=${(params.interfaces as unknown[]).length}, 数据模型数=${(params.dataModels as unknown[]).length}`,
        data: { phase: 'detail_design', ...params },
      }),
    },
    {
      name: 'DELIVERABLES',
      description: '定义交付清单：输出验收标准、测试要求、交付物列表',
      paramsSchema: {
        acceptanceCriteria: { type: 'array', required: true, description: '验收标准列表' },
        testRequirements: { type: 'array', required: true, description: '测试要求列表' },
        artifacts: { type: 'array', required: true, description: '交付物列表' },
      },
      handler: async (params) => ({
        success: true,
        observation: `交付清单完成：交付物数=${(params.artifacts as unknown[]).length}`,
        data: { phase: 'deliverables', ...params },
      }),
    },
    {
      name: 'PARALLEL_DISPATCH',
      description: '并行派发非阻塞任务给多个执行者',
      paramsSchema: {
        taskIds: { type: 'array', required: true, description: '要派发的任务 ID 列表' },
        targetExecutorId: { type: 'string', required: false, description: '目标执行者 ID' },
      },
      handler: async (params, context) => {
        const loopContext = context as { state?: any };
        const state = loopContext?.state;
        if (!state) {
          return { success: false, observation: 'PARALLEL_DISPATCH failed: no state', error: 'no state' };
        }
        const taskIds = Array.isArray(params.taskIds) ? params.taskIds as string[] : [];
        if (taskIds.length === 0) {
          return { success: false, observation: 'PARALLEL_DISPATCH failed: no taskIds', error: 'empty taskIds' };
        }
        const targetExecutorId = String(params.targetExecutorId || state.targetExecutorId || 'executor-loop');
        
        const dispatchPromises = taskIds.map(async (taskId) => {
          const task = state.taskGraph.find((t: any) => t.id === taskId);
          if (!task || task.status !== 'ready') {
            return { taskId, success: false, error: 'task not ready' };
          }
          task.status = 'in_progress';
          task.assignee = targetExecutorId;
          try {
            const result = await state.hub.sendToModule(targetExecutorId, {
              taskId,
              description: task.description,
              bdTaskId: task.bdTaskId,
            });
            task.result = { taskId, success: result.success !== false, output: result.output, error: result.error };
            if (result.success !== false) {
              task.status = 'completed';
              state.completedTasks.push(taskId);
            } else {
              task.status = 'failed';
              state.failedTasks.push(taskId);
            }
            return { taskId, success: result.success !== false, result };
          } catch (err) {
            task.status = 'failed';
            task.result = { taskId, success: false, error: String(err) };
            state.failedTasks.push(taskId);
            return { taskId, success: false, error: String(err) };
          }
        });
        
        const results = await Promise.allSettled(dispatchPromises);
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        const failCount = results.filter(r => r.status === 'fulfilled' && !r.value.success).length;
        
        return {
          success: successCount > 0,
          observation: `并行派发完成：成功${successCount}/${taskIds.length}, 失败${failCount}`,
          data: { dispatched: taskIds.length, success: successCount, failed: failCount, results },
        };
      },
    },
    {
      name: 'BLOCKED_REVIEW',
      description: '审查阻塞任务并分配最强力资源攻关',
      paramsSchema: {
        blockedTaskIds: { type: 'array', required: false, description: '要处理的阻塞任务 ID 列表 (不传则自动处理所有 blockedTasks)' },
        strongestResourceId: { type: 'string', required: false, description: '指定最强力资源 ID (可选)' },
      },
      handler: async (params, context) => {
        const loopContext = context as { state?: any };
        const state = loopContext?.state;
        if (!state) {
          return { success: false, observation: 'BLOCKED_REVIEW failed: no state', error: 'no state' };
        }
        
        // 获取阻塞任务列表
        const blockedTaskIds = Array.isArray(params.blockedTaskIds) 
          ? params.blockedTaskIds as string[] 
          : state.blockedTasks || [];
        
        if (blockedTaskIds.length === 0) {
          return { success: true, observation: '无阻塞任务需要处理', data: { handled: 0 } };
        }
        
        const targetExecutorId = String(params.strongestResourceId || state.targetExecutorId || 'executor-loop');
        const handledTasks: Array<{ taskId: string; success: boolean; error?: string }> = [];
        
        for (const taskId of blockedTaskIds) {
          const task = state.taskGraph.find((t: any) => t.id === taskId);
          if (!task) {
            handledTasks.push({ taskId, success: false, error: 'task not found' });
            continue;
          }
          
          // 检查依赖是否已解决
          const dependenciesResolved = !task.blockedBy || task.blockedBy.every((depId: string) => {
            const depTask = state.taskGraph.find((t: any) => t.id === depId);
            return depTask && depTask.status === 'completed';
          });
          
          if (!dependenciesResolved) {
            handledTasks.push({ taskId, success: false, error: 'dependencies not resolved' });
            continue;
          }
          
          // 依赖已解决，重新派发
          task.status = 'in_progress';
          task.assignee = targetExecutorId;
          
          try {
            const result = await state.hub.sendToModule(targetExecutorId, {
              taskId,
              description: task.description,
              bdTaskId: task.bdTaskId,
            });
            
            task.result = { taskId, success: result.success !== false, output: result.output, error: result.error };
            
            if (result.success !== false) {
              task.status = 'completed';
              state.completedTasks.push(taskId);
              // 从 blockedTasks 移除
              state.blockedTasks = state.blockedTasks.filter((id: string) => id !== taskId);
              handledTasks.push({ taskId, success: true });
            } else {
              task.status = 'failed';
              handledTasks.push({ taskId, success: false, error: result.error || 'execution failed' });
            }
          } catch (err) {
            task.status = 'failed';
            handledTasks.push({ taskId, success: false, error: String(err) });
          }
        }
        
        const successCount = handledTasks.filter(t => t.success).length;
        const failCount = handledTasks.filter(t => !t.success).length;
        
        return {
          success: successCount > 0 || blockedTaskIds.length === 0,
          observation: `阻塞任务审查完成：处理${blockedTaskIds.length}个，成功${successCount}个，失败${failCount}个`,
          data: { handled: handledTasks, remainingBlocked: state.blockedTasks.length },
        };
      },
    },

    {
      name: 'VERIFY',
      description: '验证交付物完成情况，决定是否完成或重规划',
      paramsSchema: {
        acceptanceCriteria: { type: 'array', required: false, description: '验收标准列表' },
        testResults: { type: 'array', required: false, description: '测试结果列表' },
        artifacts: { type: 'array', required: false, description: '交付物列表' },
      },
      handler: async (params, context) => {
        const loopContext = context as { state?: any };
        const state = loopContext?.state;
        if (!state) {
          return { success: false, observation: 'VERIFY failed: no state', error: 'no state' };
        }
        
        const deliverables = state.deliverables;
        if (!deliverables) {
          return { success: false, observation: 'VERIFY failed: no deliverables defined', error: 'no deliverables' };
        }
        
        const verificationResult = {
          passed: true,
          missingDeliverables: [] as string[],
          failedTests: [] as string[],
          completedArtifacts: [] as string[],
        };
        
        // 检查交付物
        const expectedArtifacts = deliverables.artifacts || [];
        for (const artifact of expectedArtifacts) {
          // 简单检查：如果任务图中有对应完成的任务则认为交付物存在
          const relatedTask = state.taskGraph.find((t: any) => 
            t.description.includes(artifact) && t.status === 'completed'
          );
          if (relatedTask) {
            verificationResult.completedArtifacts.push(artifact);
          } else {
            verificationResult.missingDeliverables.push(artifact);
            verificationResult.passed = false;
          }
        }
        
        // 检查测试结果
        const testResults = Array.isArray(params.testResults) ? params.testResults as any[] : [];
        for (const result of testResults) {
          if (!result.success) {
            verificationResult.failedTests.push(result.name || 'unknown test');
            verificationResult.passed = false;
          }
        }
        
        // 检查任务完成率
        const totalTasks = state.taskGraph.length;
        const completedTasks = state.completedTasks.length;
        // const failedTasks = state.failedTasks.length;
        const completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0;
        
        // 判定标准：所有交付物完成 + 无失败测试 + 完成率>80%
        const allDeliverablesComplete = verificationResult.missingDeliverables.length === 0;
        const noFailedTests = verificationResult.failedTests.length === 0;
        const highCompletionRate = completionRate >= 0.8;
        
        const overallPassed = allDeliverablesComplete && noFailedTests && highCompletionRate;
        
        if (overallPassed) {
          return {
            success: true,
            observation: `交付物验证通过：交付物${completedTasks}/${totalTasks}完成，无失败测试`,
            data: { 
              passed: true, 
              completionRate: Math.round(completionRate * 100) + '%',
              completedArtifacts: verificationResult.completedArtifacts,
              shouldComplete: true,
            },
            shouldStop: true,
            stopReason: 'complete',
          };
        } else {
          const issues = [];
          if (verificationResult.missingDeliverables.length > 0) {
            issues.push(`缺失交付物：${verificationResult.missingDeliverables.join(', ')}`);
          }
          if (verificationResult.failedTests.length > 0) {
            issues.push(`失败测试：${verificationResult.failedTests.join(', ')}`);
          }
          if (!highCompletionRate) {
            issues.push(`完成率过低：${Math.round(completionRate * 100)}%`);
          }
          
          return {
            success: false,
            observation: `交付物验证失败：${issues.join('; ')}`,
            data: { 
              passed: false, 
              missingDeliverables: verificationResult.missingDeliverables,
              failedTests: verificationResult.failedTests,
              completionRate: Math.round(completionRate * 100) + '%',
              shouldReplan: true,
            },
          };
        }
      },
    },
    {
      name: 'PLAN',
      description: '拆解任务为子任务列表',
      paramsSchema: { tasks: { type: 'array', required: true } },
      handler: async (params) => ({
        success: true,
        observation: `已拆解 ${(params.tasks as unknown[]).length} 个子任务`,
      }),
    },
    {
      name: 'DISPATCH',
      description: '派发任务给执行者',
      paramsSchema: { taskId: { type: 'string', required: true } },
      handler: async (params) => ({
        success: true,
        observation: `任务 ${params.taskId} 已派发`,
      }),
    },
    {
      name: 'COMPLETE',
      description: '编排完成',
      paramsSchema: { summary: { type: 'string', required: true } },
      handler: async (params) => ({
        success: true,
        observation: `编排完成: ${params.summary}`,
        shouldStop: true,
        stopReason: 'complete',
      }),
    },
    {
      name: 'FAIL',
      description: '编排失败',
      paramsSchema: { reason: { type: 'string', required: true } },
      handler: async (params) => ({
        success: false,
        observation: `编排失败: ${params.reason}`,
        error: params.reason as string,
        shouldStop: true,
        stopReason: 'fail',
      }),
    },
  ];
}
