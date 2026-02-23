/**
 * Agent 提示词统一类型定义
 * 
 * 所有 Agent 必须输出此结构，确保阶段间数据流转一致
 */

/**
 * Agent 统一输出结构
 * 
 * 所有阶段的 Agent 都必须输出此结构的 JSON
 */
export interface AgentOutput {
  // 推理过程（必须）
  thought: string;
  
  // 行动/决策（必须）
  action: string;
  
  // 行动参数（必须）
  params: Record<string, unknown>;
  
  // 预期结果（必须）
  expectedOutcome: string;
  
  // 风险评估（必须）
  risk: {
    level: 'low' | 'medium' | 'high';
    description: string;
    mitigation?: string;
  };
  
  // 置信度 0-100（必须）
  confidence: number;
  
  // 备选方案（可选）
  alternativeActions?: string[];
  
  // 需要用户确认（可选）
  requiresUserConfirmation?: boolean;
  
  // 给用户看的消息（可选）
  userMessage?: string;
}

/**
 * 标准化意图
 */
export interface NormalizedIntent {
  goal: string;
  action: 'create' | 'modify' | 'query' | 'cancel' | 'continue' | 'clarify';
  scope: 'full_task' | 'partial_task' | 'meta_control';
  urgency: 'high' | 'medium' | 'low';
}

/**
 * 任务关系判定
 */
export interface TaskRelation {
  type: 'same_task_no_change' 
       | 'same_task_minor_change' 
       | 'same_task_major_change' 
       | 'different_task' 
       | 'control_instruction';
  confidence: number;
  reasoning: string;
}

/**
 * 上下文依赖
 */
export interface ContextDependency {
  needsCurrentTaskContext: boolean;
  needsExecutionHistory: boolean;
  needsResourceStatus: boolean;
  referencedEntities: string[];
}

/**
 * 路由建议
 */
export interface SuggestedRoute {
  nextPhase: 'plan_loop' | 'execution' | 'replan' | 'new_task' | 'wait_user' | 'control';
  reason: string;
  requiresUserConfirmation: boolean;
}

/**
 * Understanding Agent 输出
 */
export interface UnderstandingOutput extends AgentOutput {
  action: 'INTENT_ANALYSIS' | 'CLARIFICATION_REQUIRED';
  params: {
    normalizedIntent: NormalizedIntent;
    taskRelation: TaskRelation;
    contextDependency: ContextDependency;
    suggestedRoute: SuggestedRoute;
  };
}

/**
 * Router Agent 输出
 */
export interface RouterOutput extends AgentOutput {
  action: 'ROUTE_DECISION';
  params: {
    route: 'continue_execution' | 'minor_replan' | 'full_replan' | 'new_task' | 'control_action' | 'wait_user_decision';
    confidence: number;
    payload?: {
      reason: string;
      requiresConfirmation: boolean;
      planPatches?: PlanPatch[];
      controlAction?: 'pause' | 'resume' | 'cancel' | 'status_query';
      replanTrigger?: string;
      newTaskJustification?: string;
    };
  };
}

/**
 * Planner Agent 输出
 */
export interface PlannerOutput extends AgentOutput {
  action: string; // 工具名称
  params: Record<string, unknown>; // 工具参数
}

/**
 * Reviewer Agent 输出
 */
export interface ReviewerOutput extends AgentOutput {
  action: 'REVIEW_APPROVE' | 'REVIEW_REJECT';
  params: {
    approved: boolean;
    score: number;
    feedback: string;
    requiredFixes: string[];
    riskLevel: 'low' | 'medium' | 'high';
    alternativeAction?: string;
  };
}

/**
 * 计划补丁
 */
export interface PlanPatch {
  taskId: string;
  patchType: 'add' | 'modify' | 'remove' | 'reorder';
  changes: Record<string, unknown>;
}

/**
 * 系统状态（注入到提示词）
 */
export interface SystemStateContext {
  workflowStatus: 'idle' | 'plan_loop' | 'execution' | 'paused' | 'completed' | 'failed';
  currentTask?: {
    goal: string;
    progress: number;
    completedTasks: number;
    failedTasks: number;
    blockedTasks: number;
  };
  lastActivity: string;
  availableResources: string[];
}

/**
 * 执行快照（注入到提示词）
 */
export interface ExecutionSnapshot {
  completedTasks: string[];
  failedTasks: string[];
  blockedTasks: string[];
  inProgressTasks: string[];
}

/**
 * 提示词渲染上下文
 */
export interface PromptRenderContext {
  systemState: SystemStateContext;
  executionSnapshot?: ExecutionSnapshot;
  history: Array<{
    role: 'user' | 'agent';
    content: string;
    timestamp: string;
  }>;
  images?: Array<{
    id: string;
    name: string;
    url: string;
  }>;
}
