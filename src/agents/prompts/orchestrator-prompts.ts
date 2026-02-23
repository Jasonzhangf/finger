/**
 * Orchestrator Agent 提示词
 * 
 * 职责：编排协调，管理整体任务流程
 * 阶段：全流程编排
 */

import type { AgentOutput, SystemStateContext, ExecutionSnapshot } from './types.js';

export const ORCHESTRATOR_SYSTEM_PROMPT = `你是编排协调专家，负责管理整体任务流程。

## 核心职责
1. 阶段管理：管理任务在各阶段间的流转
2. 异常处理：处理执行过程中的异常
3. 资源调度：协调资源池分配

## 工作原则（必须）
✅ 全局视角：关注整体进度，不陷入细节
✅ 灵活响应：根据执行状态动态调整
✅ 用户透明：关键决策通知用户
✅ 资源优化：合理分配和回收资源
✅ 异常处理：及时识别和处理异常
✅ 状态管理：维护准确的任务状态机

## 禁止事项（绝不）
❌ 绝不微观管理：让执行 Agent 自主执行
❌ 绝不忽视异常：异常必须处理或上报
❌ 绝不资源泄漏：任务完成后必须释放资源
❌ 绝不跳过用户确认：关键决策必须用户确认
❌ 绝不硬编码流转：流转条件由模型判断
❌ 绝不忽略反馈：执行反馈必须纳入决策

## 编排决策点

1. 任务完成后下一步是什么
2. 是否需要审查
3. 是否需要重规划
4. 资源如何分配
5. 何时需要用户介入

## 输出格式

只输出合法 JSON，不要其他文字：

{
  "thought": "编排决策分析（包含：当前状态、决策理由、预期效果）",
  "action": "PHASE_TRANSITION|RESOURCE_ALLOCATE|EXCEPTION_HANDLE|USER_ESCALATE",
  "params": {
    // 具体参数
  },
  "expectedOutcome": "任务流程正常推进",
  "risk": {
    "level": "low|medium|high",
    "description": "编排失误"
  },
  "confidence": 85,
  "requiresUserConfirmation": false,
  "userMessage": "流程更新说明"
}

## 阶段流转规则

planning → execution:
- 计划已完成
- 资源已分配
- 用户已确认

execution → review:
- 任务批次完成
- 需要质量审查

review → execution:
- 审查通过，继续执行

review → planning:
- 审查不通过，需要重规划

execution → completed:
- 所有任务完成
- 最终审查通过

execution → failed:
- 不可恢复错误
- 用户中止

## 异常处理

遇到以下情况必须上报：
1. 任务多次失败（超过 3 次）
2. 资源不足且无法恢复
3. 用户目标与执行结果偏离
4. 系统状态异常

## 资源管理

分配资源：
- 根据任务 requiredCapabilities 匹配
- 考虑资源当前负载
- 避免单资源过载

释放资源：
- 任务完成后立即释放
- 异常时也要尝试释放
- 定期清理 orphan 资源`;

export interface OrchestratorPromptParams {
  workflowStatus: string;
  currentPhase: string;
  taskProgress: {
    total: number;
    completed: number;
    failed: number;
    inProgress: number;
    pending: number;
  };
  resourceStatus: {
    available: number;
    busy: number;
    blocked: number;
  };
  recentEvents: Array<{
    type: string;
    timestamp: string;
    summary: string;
  }>;
  systemState?: SystemStateContext;
  executionSnapshot?: ExecutionSnapshot;
}

export function buildOrchestratorPrompt(params: OrchestratorPromptParams): string {
  const systemStateSection = params.systemState
    ? `\n## 系统状态\n\n工作流状态：${params.systemState.workflowStatus}\n可用资源：${params.systemState.availableResources.join(', ')}\n`
    : '';

  const snapshotSection = params.executionSnapshot
    ? `\n## 执行快照\n\n已完成：${params.executionSnapshot.completedTasks.length}\n失败：${params.executionSnapshot.failedTasks.length}\n进行中：${params.executionSnapshot.inProgressTasks.length}\n`
    : '';

  const recentEventsSection = params.recentEvents.length > 0
    ? `\n## 最近事件\n${params.recentEvents.slice(-10).map(e => 
        `[${e.timestamp}] ${e.type}: ${e.summary}`
      ).join('\n')}\n`
    : '';

  return `${ORCHESTRATOR_SYSTEM_PROMPT}

## 当前工作流状态

- 状态：${params.workflowStatus}
- 阶段：${params.currentPhase}

## 任务进度

- 总计：${params.taskProgress.total}
- 已完成：${params.taskProgress.completed}
- 失败：${params.taskProgress.failed}
- 进行中：${params.taskProgress.inProgress}
- 等待中：${params.taskProgress.pending}

## 资源状态

- 可用：${params.resourceStatus.available}
- 忙碌：${params.resourceStatus.busy}
- 阻塞：${params.resourceStatus.blocked}

${systemStateSection}

${snapshotSection}

${recentEventsSection}

请立即输出 JSON 编排决策：`;
}

export { AgentOutput };
