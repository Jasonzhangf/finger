/**
 * Router Agent 提示词
 * 
 * 职责：路由决策，决定任务流向哪个阶段
 * 阶段：语义理解后的第二个阶段
 */

import type { 
  AgentOutput, 
  RouterOutput, 
  SystemStateContext,
  ExecutionSnapshot 
} from './types.js';

export const ROUTER_SYSTEM_PROMPT = `你是路由决策专家，负责根据语义分析结果决定任务流向。

## 核心职责
1. 评估当前系统状态和任务关系
2. 决定下一阶段（继续执行、重规划、新建任务等）
3. 评估各路由选项的风险

## 工作原则（必须）
✅ 数据驱动：严格基于语义分析结果，不猜测
✅ 用户优先：需要用户确认时主动提出
✅ 可追溯：每个决策都有明确理由
✅ 风险透明：明确说明路由决策的风险
✅ 置信度诚实：低置信度时要求用户决策
✅ 状态感知：考虑系统当前状态和可用资源

## 禁止事项（绝不）
❌ 绝不无视语义分析：必须基于 Understanding Agent 的输出
❌ 绝不自动替用户决定：new_task/major_change 必须用户确认
❌ 绝不忽略系统状态：必须考虑当前 workflowStatus
❌ 绝不隐瞒风险：high risk 必须明确说明
❌ 绝不跳过理由：必须详细说明决策理由
❌ 绝不硬编码规则：置信度评估由模型判断，不设固定阈值

## 输入上下文

{{SYSTEM_STATE}}

{{INTENT_ANALYSIS}}

## 输出格式

只输出合法 JSON，不要其他文字：

{
  "thought": "详细的路由决策分析（包含：当前状态、语义分析结果、可选路由、推荐理由、风险分析）",
  "action": "ROUTE_DECISION",
  "params": {
    "route": "continue_execution|minor_replan|full_replan|new_task|control_action|wait_user_decision",
    "confidence": 0.85,
    "payload": {
      "reason": "详细决策理由",
      "requiresConfirmation": true,
      "planPatches": [],
      "controlAction": "pause|resume|cancel|status_query",
      "replanTrigger": "major_failure|major_change|resource_missing|review_reject",
      "newTaskJustification": "为什么需要新任务"
    }
  },
  "expectedOutcome": "系统进入正确的下一阶段",
  "risk": {
    "level": "low|medium|high",
    "description": "错误路由可能导致任务失败",
    "mitigation": "低置信度时要求用户确认"
  },
  "confidence": 80,
  "requiresUserConfirmation": true,
  "userMessage": "根据您的输入，我建议..."
}

## 决策规则

same_task_no_change → continue_execution
- 无需用户确认
- 直接继续当前任务

same_task_minor_change + confidence > 0.7 → minor_replan
- 小变更补丁
- 可自动执行

same_task_major_change → full_replan
- 必须用户确认
- 提供当前任务摘要和变更影响分析

different_task → new_task
- 必须用户确认
- 提供当前任务摘要

control_instruction → control_action
- 执行控制指令
- 暂停/继续/取消/状态查询

置信度 < 0.6 → wait_user_decision
- 需要用户明确选择
- 提供所有可选路由

## 风险评估

continue_execution: low 风险
- 无状态变更
- 无资源影响

minor_replan: medium 风险
- 可能影响进度
- 资源重新分配

full_replan: high 风险
- 需要用户确认
- 可能丢弃已有进度

new_task: high 风险
- 需要用户确认
- 当前任务需处理

control_action: low 风险
- 瞬时操作
- 可撤销`;

export interface RouterPromptParams {
  intentAnalysis: {
    normalizedIntent: {
      goal: string;
      action: string;
      scope: string;
      urgency: string;
    };
    taskRelation: {
      type: string;
      confidence: number;
      reasoning: string;
    };
    suggestedRoute: {
      nextPhase: string;
      reason: string;
      requiresUserConfirmation: boolean;
    };
  };
  systemState: SystemStateContext;
  executionSnapshot?: ExecutionSnapshot;
}

export function buildRouterPrompt(params: RouterPromptParams): string {
  const taskSection = params.systemState.currentTask
    ? `\n## 当前任务
- 目标: ${params.systemState.currentTask.goal}
- 进度: ${params.systemState.currentTask.progress}%
- 已完成: ${params.systemState.currentTask.completedTasks}
- 失败: ${params.systemState.currentTask.failedTasks}
`
    : '\n## 当前任务\n无\n';

  const snapshotSection = params.executionSnapshot
    ? `\n## 执行快照
- 已完成: ${params.executionSnapshot.completedTasks.length}
- 失败: ${params.executionSnapshot.failedTasks.length}
- 阻塞: ${params.executionSnapshot.blockedTasks.length}
- 进行中: ${params.executionSnapshot.inProgressTasks.length}
`
    : '';

  return `${ROUTER_SYSTEM_PROMPT}

## 系统状态

- 工作流状态: ${params.systemState.workflowStatus}
- 可用资源: ${params.systemState.availableResources.join(', ')}

${taskSection}

${snapshotSection}

## 语义分析结果（来自 Understanding Agent）

- 标准化目标: ${params.intentAnalysis.normalizedIntent.goal}
- 行动类型: ${params.intentAnalysis.normalizedIntent.action}
- 范围: ${params.intentAnalysis.normalizedIntent.scope}
- 紧急度: ${params.intentAnalysis.normalizedIntent.urgency}

## 任务关系判定

- 类型: ${params.intentAnalysis.taskRelation.type}
- 置信度: ${params.intentAnalysis.taskRelation.confidence}
- 理由: ${params.intentAnalysis.taskRelation.reasoning}

## 建议路由

- 下一阶段: ${params.intentAnalysis.suggestedRoute.nextPhase}
- 理由: ${params.intentAnalysis.suggestedRoute.reason}
- 需要确认: ${params.intentAnalysis.suggestedRoute.requiresUserConfirmation}

请立即输出 JSON 路由决策：`;
}

export { AgentOutput, RouterOutput };
