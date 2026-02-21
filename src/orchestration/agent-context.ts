/**
 * Agent Context - 标准上下文结构
 * 提供给每个 Agent 的标准化上下文信息
 */

import { resourcePool } from './resource-pool.js';

/**
 * 能力目录项
 */
export interface CapabilityEntry {
  capability: string;
  resourceCount: number;
  availableCount: number;
  resources: Array<{
    id: string;
    name: string;
    level: number;
    status: string;
  }>;
}

/**
 * 资源池状态摘要
 */
export interface ResourcePoolSummary {
  totalResources: number;
  available: number;
  busy: number;
  error: number;
  capabilityCatalog: CapabilityEntry[];
}

/**
 * 标准 Agent 上下文
 * 所有 Agent 启动时都会收到这个上下文
 */
export interface AgentContext {
  /** 当前时间戳 */
  timestamp: string;
  
  /** 资源池状态 */
  resourcePool: ResourcePoolSummary;
  
  /** 可用能力列表（仅 available > 0 的能力） */
  availableCapabilities: string[];
  
  /** 能力 - 资源映射（快速查找） */
  capabilityToResources: Record<string, string[]>;
  
  /** 任务相关信息（可选，派发任务时填充） */
  task?: {
    id: string;
    description: string;
    requiredCapabilities?: string[];
    bdTaskId?: string;
    epicId?: string;
    executionLoopId?: string;
  };
  
  /** 编排者指令（可选） */
  orchestratorNote?: string;
}

/**
 * 获取资源池状态摘要
 */
export function getResourcePoolSummary(): ResourcePoolSummary {
  const status = resourcePool.getStatusReport();
  const catalog = resourcePool.getCapabilityCatalog();
  
  return {
    totalResources: status.totalResources,
    available: status.available,
    busy: status.busy,
    error: status.error,
    capabilityCatalog: catalog,
  };
}

/**
 * 构建 Agent 上下文
 */
export function buildAgentContext(options?: {
  taskId?: string;
  taskDescription?: string;
  requiredCapabilities?: string[];
  bdTaskId?: string;
  orchestratorNote?: string;
  epicId?: string;
  executionLoopId?: string;
}): AgentContext {
  const summary = getResourcePoolSummary();
  
  // Extract available capabilities
  const availableCapabilities = summary.capabilityCatalog
    .filter(c => c.availableCount > 0)
    .map(c => c.capability);
  
  // Build capability -> resources mapping
  const capabilityToResources: Record<string, string[]> = {};
  for (const cap of summary.capabilityCatalog) {
    capabilityToResources[cap.capability] = cap.resources
      .filter(r => r.status === 'available' || r.status === 'deployed')
      .map(r => r.id);
  }
  
  const context: AgentContext = {
    timestamp: new Date().toISOString(),
    resourcePool: summary,
    availableCapabilities,
    capabilityToResources,
  };
  
  // Add task info if provided
  if (options?.taskId) {
    context.task = {
      id: options.taskId,
      description: options.taskDescription || '',
      requiredCapabilities: options.requiredCapabilities,
      bdTaskId: options.bdTaskId,
      epicId: options.epicId,
      executionLoopId: options.executionLoopId,
    };
  }
  
  // Add orchestrator note if provided
  if (options?.orchestratorNote) {
    context.orchestratorNote = options.orchestratorNote;
  }
  
  return context;
}

/**
 * 将上下文格式化为系统提示词片段
 */
export function contextToSystemPrompt(context: AgentContext): string {
  const lines: string[] = [];
  
  lines.push('## 当前资源池状态');
  lines.push(`- 总资源数：${context.resourcePool.totalResources}`);
  lines.push(`- 可用：${context.resourcePool.available}`);
  lines.push(`- 忙碌：${context.resourcePool.busy}`);
  lines.push(`- 错误：${context.resourcePool.error}`);
  lines.push('');
  
  lines.push('## 可用能力目录');
  lines.push('');
  lines.push('| 能力 | 可用资源数 | 总资源数 | 可用资源 ID |');
  lines.push('|------|-----------|---------|------------|');
  
  for (const cap of context.resourcePool.capabilityCatalog) {
    const availableIds = cap.resources
      .filter(r => r.status === 'available' || r.status === 'deployed')
      .map(r => r.id)
      .join(', ');
    lines.push(`| ${cap.capability} | ${cap.availableCount} | ${cap.resourceCount} | ${availableIds || '无'} |`);
  }
  
  lines.push('');
  
  if (context.task) {
    lines.push('## 当前任务');
    lines.push(`- ID: ${context.task.id}`);
    lines.push(`- 描述：${context.task.description}`);
    if (context.task.requiredCapabilities?.length) {
      lines.push(`- 所需能力：${context.task.requiredCapabilities.join(', ')}`);
    }
    lines.push('');
  }
  
  if (context.orchestratorNote) {
    lines.push('## 编排者指令');
    lines.push(context.orchestratorNote);
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * 生成动态系统提示词
 */
export function generateDynamicSystemPrompt(basePrompt: string, context?: AgentContext): string {
  if (!context) {
    return basePrompt;
  }
  
  const contextSection = contextToSystemPrompt(context);
  return `${basePrompt}\n\n${contextSection}`;
}
