/**
 * Agent 提示词集合
 * 
 * 所有 Agent 使用统一的输出结构，不同阶段职责不同
 * 每个 Agent 都有明确的"工作原则（必须）"和"禁止事项（绝不）"
 */

// 类型定义
export * from './types.js';

// 各阶段提示词
export * from './understanding-prompts.js';
export * from './router-prompts.js';
export * from './planner-prompts.js';
export * from './reviewer-prompts.js';
export * from './executor-prompts.js';
export * from './orchestrator-prompts.js';

// 工具函数
import type { PromptRenderContext, SystemStateContext } from './types.js';

/**
 * 格式化系统状态为提示词文本
 */
export function formatSystemState(state: SystemStateContext): string {
  const lines = [
    `工作流状态：${state.workflowStatus}`,
    `最后活动：${state.lastActivity}`,
    `可用资源：${state.availableResources.join(', ')}`,
  ];
  
  if (state.currentTask) {
    lines.push(
      '',
      '当前任务:',
      `- 目标：${state.currentTask.goal}`,
      `- 进度：${state.currentTask.progress}%`,
      `- 已完成：${state.currentTask.completedTasks}`,
      `- 失败：${state.currentTask.failedTasks}`,
      `- 阻塞：${state.currentTask.blockedTasks}`
    );
  }
  
  return lines.join('\n');
}

/**
 * 格式化历史记录为提示词文本
 */
export function formatHistory(history: PromptRenderContext['history']): string {
  if (!history || history.length === 0) {
    return '暂无历史记录';
  }
  
  return history
    .slice(-10)
    .map(h => `[${h.role}] ${h.content.substring(0, 300)}`)
    .join('\n');
}

/**
 * 格式化图片列表为提示词文本
 */
export function formatImages(images: PromptRenderContext['images']): string {
  if (!images || images.length === 0) {
    return '';
  }
  
  return `用户上传的图片:\n${images.map(img => `- ${img.name}`).join('\n')}`;
}

/**
 * 格式化工具列表为提示词文本
 */
export function formatTools(tools: Array<{ name: string; description: string; params: Record<string, unknown> }>): string {
  if (!tools || tools.length === 0) {
    return '暂无可用工具';
  }
  
  return tools
    .map(t => `- ${t.name}: ${t.description}\n  参数：${JSON.stringify(t.params, null, 2)}`)
    .join('\n');
}
