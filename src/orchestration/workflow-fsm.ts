/**
 * Workflow Finite State Machine - 工作流状态机
 * 
 * 管理工作流在各阶段间的流转，包括：
 * - 语义理解阶段
 * - 路由决策阶段
 * - 任务规划阶段
 * - 任务执行阶段
 * - 审查阶段
 * - 完成/失败阶段
 */

import { globalEventBus } from '../runtime/event-bus.js';

/**
 * 工作流状态枚举
 */
export type WorkflowState =
  | 'idle'                    // 空闲状态
  | 'semantic_understanding'  // 语义理解中
  | 'routing_decision'        // 路由决策中
  | 'plan_loop'               // 任务规划循环
  | 'execution'               // 任务执行中
  | 'review'                  // 审查中
  | 'replan_evaluation'       // 重规划评估
  | 'wait_user_decision'      // 等待用户决策
  | 'paused'                  // 已暂停
  | 'completed'               // 已完成
  | 'failed' | '*';                 // 已失败

/**
 * 任务状态枚举
 */
export type TaskState =
  | 'created'          // 已创建
  | 'ready'            // 就绪（依赖已满足）
  | 'dispatching'      // 派发中
  | 'dispatched'       // 已派发（收到 ACK）
  | 'dispatch_failed'  // 派发失败（NACK/超时/无资源）
  | 'running'          // 执行中
  | 'execution_failed' // 执行失败
  | 'execution_succeeded' // 执行成功
  | 'reviewing'        // 审查中
  | 'done'             // 完成
  | 'rework_required'  // 需要返工
  | 'blocked'          // 阻塞

/**
 * Agent 状态枚举
 */
export type AgentState =
  | 'idle'       // 空闲
  | 'reserved'   // 已预留（收到 dispatch ACK）
  | 'running'    // 执行中
  | 'error'      // 错误
  | 'released';  // 已释放

/**
 * 状态转换触发器
 */
export type StateTransitionTrigger =
  | 'user_input_received'
  | 'intent_analyzed'
  | 'routing_decided'
  | 'plan_created'
  | 'task_dispatched'
  | 'task_started'
  | 'task_progress'
  | 'task_completed'
  | 'task_failed'
  | 'review_passed'
  | 'review_rejected'
  | 'major_change_detected'
  | 'resource_missing'
  | 'user_decision_received'
  | 'pause_requested'
  | 'resume_requested'
  | 'cancel_requested'
  | 'error_occurred';

/**
 * 状态转换定义
 */
export interface StateTransition {
  from: WorkflowState | '*';
  to: WorkflowState | '*';
  trigger: StateTransitionTrigger;
  guard?: (context: WorkflowContext) => boolean;
  action?: (context: WorkflowContext) => void | Promise<void>;
}

/**
 * 工作流上下文
 */
export interface WorkflowContext {
  workflowId: string;
  sessionId: string;
  currentState: WorkflowState;
  userTask?: string;
  intentAnalysis?: unknown;
  routingDecision?: unknown;
  plan?: unknown;
  tasks?: TaskInfo[];
  activeAgents?: string[];
  lastError?: string;
  [key: string]: unknown;
}

/**
 * 任务信息
 */
export interface TaskInfo {
  id: string;
  description: string;
  status: TaskState;
  assignee?: string;
  dependencies?: string[];
  result?: {
    success: boolean;
    output?: string;
    error?: string;
  };
}

/**
 * 状态机配置
 */
export interface FSMConfig {
  workflowId: string;
  sessionId: string;
  initialState?: WorkflowState;
}

/**
 * 工作流状态机类
 */
export class WorkflowFSM {
  private config: FSMConfig;
  private currentState: WorkflowState;
  private context: WorkflowContext;
  private transitions: StateTransition[] = [];
  private stateHistory: Array<{
    state: WorkflowState;
    timestamp: string;
    trigger: StateTransitionTrigger;
  }> = [];

  constructor(config: FSMConfig) {
    this.config = config;
    this.currentState = config.initialState || 'idle';
    this.context = {
      workflowId: config.workflowId,
      sessionId: config.sessionId,
      currentState: this.currentState,
    };
    this.initializeTransitions();
  }

  /**
   * 初始化状态转换规则
   */
  private initializeTransitions(): void {
    // 空闲 → 语义理解
    this.addTransition({
      from: 'idle',
      to: 'semantic_understanding',
      trigger: 'user_input_received',
    });

    // 语义理解 → 路由决策
    this.addTransition({
      from: 'semantic_understanding',
      to: 'routing_decision',
      trigger: 'intent_analyzed',
    });

    // 路由决策 → 任务规划
    this.addTransition({
      from: 'routing_decision',
      to: 'plan_loop',
      trigger: 'routing_decided',
      guard: (ctx) => {
        const decision = ctx.routingDecision as { route?: string } | undefined;
        return decision?.route === 'full_replan' || decision?.route === 'minor_replan';
      },
    });

    // 路由决策 → 任务执行
    this.addTransition({
      from: 'routing_decision',
      to: 'execution',
      trigger: 'routing_decided',
      guard: (ctx) => {
        const decision = ctx.routingDecision as { route?: string } | undefined;
        return decision?.route === 'continue_execution';
      },
    });

    // 路由决策 → 等待用户决策
    this.addTransition({
      from: 'routing_decision',
      to: 'wait_user_decision',
      trigger: 'routing_decided',
      guard: (ctx) => {
        const decision = ctx.routingDecision as { route?: string } | undefined;
        return decision?.route === 'wait_user_decision' || decision?.route === 'new_task';
      },
    });

    // 任务规划 → 任务执行
    this.addTransition({
      from: 'plan_loop',
      to: 'execution',
      trigger: 'plan_created',
    });

    // 任务执行 → 审查
    this.addTransition({
      from: 'execution',
      to: 'review',
      trigger: 'task_completed',
    });

    // 审查 → 任务执行
    this.addTransition({
      from: 'review',
      to: 'execution',
      trigger: 'review_passed',
    });

    // 审查 → 任务规划
    this.addTransition({
      from: 'review',
      to: 'plan_loop',
      trigger: 'review_rejected',
    });

    // 任务执行 → 重规划评估
    this.addTransition({
      from: 'execution',
      to: 'replan_evaluation',
      trigger: 'major_change_detected',
    });

    // 重规划评估 → 任务规划
    this.addTransition({
      from: 'replan_evaluation',
      to: 'plan_loop',
      trigger: 'routing_decided',
      guard: (ctx) => {
        const decision = ctx.routingDecision as { route?: string } | undefined;
        return decision?.route === 'full_replan';
      },
    });

    // 重规划评估 → 任务执行
    this.addTransition({
      from: 'replan_evaluation',
      to: 'execution',
      trigger: 'routing_decided',
      guard: (ctx) => {
        const decision = ctx.routingDecision as { route?: string } | undefined;
        return decision?.route === 'continue_execution';
      },
    });

    // 任何状态 → 暂停
    this.addTransition({
      from: '*',
      to: 'paused',
      trigger: 'pause_requested',
    });

    // 暂停 → 语义理解（新输入）
    this.addTransition({
      from: 'paused',
      to: 'semantic_understanding',
      trigger: 'user_input_received',
    });

    // 暂停 → 原状态（恢复）
    this.addTransition({
      from: 'paused',
      to: '*',
      trigger: 'resume_requested',
      action: (_ctx) => {
        // 恢复到暂停前的状态
        const previousState = this.stateHistory[this.stateHistory.length - 2]?.state;
        if (previousState && previousState !== 'paused') {
          this.currentState = previousState;
        }
      },
    });

    // 任务执行 → 完成
    this.addTransition({
      from: 'execution',
      to: 'completed',
      trigger: 'task_completed',
      guard: (ctx) => {
        const tasks = ctx.tasks as TaskInfo[] | undefined;
        if (!tasks) return false;
        return tasks.every(t => t.status === 'done' || t.status === 'execution_succeeded');
      },
    });

    // 任何状态 → 失败
    this.addTransition({
      from: '*',
      to: 'failed',
      trigger: 'error_occurred',
      guard: (ctx) => {
        return !!ctx.lastError;
      },
    });
  }

  /**
   * 添加状态转换规则
   */
  addTransition(transition: StateTransition): void {
    this.transitions.push(transition);
  }

  /**
   * 触发状态转换
   */
  async trigger(trigger: StateTransitionTrigger, contextUpdate?: Partial<WorkflowContext>): Promise<boolean> {
    // 更新上下文
    if (contextUpdate) {
      Object.assign(this.context, contextUpdate);
    }
    this.context.currentState = this.currentState;

    // 查找匹配的转换
    const matchingTransition = this.transitions.find(t => {
      if (t.from !== '*' && t.from !== this.currentState) return false;
      if (t.trigger !== trigger) return false;
      if (t.guard && !t.guard(this.context)) return false;
      return true;
    });

    if (!matchingTransition) {
      console.warn(`[WorkflowFSM] No matching transition for trigger: ${trigger} from state: ${this.currentState}`);
      return false;
    }

    const oldState = this.currentState;
    let newState = matchingTransition.to;

    // 处理通配符目标
    if (newState === '*') {
      // 由 action 决定新状态
      if (matchingTransition.action) {
        await matchingTransition.action(this.context);
        newState = this.context.currentState as WorkflowState;
      } else {
        console.warn('[WorkflowFSM] Wildcard transition requires action');
        return false;
      }
    } else {
      // 执行转换
      this.currentState = newState;
      this.context.currentState = newState;
    }

    // 执行动作
    if (matchingTransition.action) {
      await matchingTransition.action(this.context);
    }

    // 记录历史
    this.stateHistory.push({
      state: newState,
      timestamp: new Date().toISOString(),
      trigger,
    });

    // 发送事件
    globalEventBus.emit({
      type: 'phase_transition',
      sessionId: this.context.sessionId,
      agentId: 'orchestrator-loop',
      timestamp: new Date().toISOString(),
      payload: {
        from: oldState,
        to: newState,
        triggerAction: trigger,
        round: this.stateHistory.length,
      },
    });

    console.log(`[WorkflowFSM] Transition: ${oldState} → ${newState} (trigger: ${trigger})`);
    return true;
  }

  /**
   * 获取当前状态
   */
  getState(): WorkflowState {
    return this.currentState;
  }

  /**
   * 获取上下文
   */
  getContext(): WorkflowContext {
    return { ...this.context };
  }

  /**
   * 更新上下文
   */
  updateContext(update: Partial<WorkflowContext>): void {
    Object.assign(this.context, update);
  }

  /**
   * 获取状态历史
   */
  getStateHistory(): Array<{ state: WorkflowState; timestamp: string; trigger: string }> {
    return [...this.stateHistory];
  }

  /**
   * 检查是否在特定状态
   */
  isInState(state: WorkflowState): boolean {
    return this.currentState === state;
  }

  /**
   * 重置状态机
   */
  reset(initialState?: WorkflowState): void {
    this.currentState = initialState || 'idle';
    this.context.currentState = this.currentState;
    this.stateHistory = [];
  }
}

/**
 * 任务状态机
 */
export class TaskFSM {
  private taskId: string;
  private currentState: TaskState;

  constructor(taskId: string, initialState: TaskState = 'created') {
    this.taskId = taskId;
    this.currentState = initialState;
  }

  transition(trigger: string, _context?: unknown): boolean {
    const transitions: Record<TaskState, Record<string, TaskState>> = {
      'created': { 'deps_satisfied': 'ready' },
      'ready': { 'orchestrator_dispatch': 'dispatching' },
      'dispatching': { 
        'dispatch_ack': 'dispatched',
        'dispatch_nack': 'dispatch_failed',
        'timeout': 'dispatch_failed',
        'no_resource': 'dispatch_failed',
      },
      'dispatched': { 'task_execution_started': 'running' },
      'dispatch_failed': { 
        'recoverable_retry': 'ready',
        'unrecoverable': 'blocked',
      },
      'running': {
        'task_progress': 'running',
        'task_execution_result_success': 'execution_succeeded',
        'task_execution_result_failure': 'execution_failed',
      },
      'execution_failed': { 'retry_or_reassign': 'ready' },
      'execution_succeeded': { 'review_requested': 'reviewing' },
      'reviewing': {
        'review_pass': 'done',
        'review_reject': 'rework_required',
      },
      'rework_required': { 'replan_or_retry': 'ready' },
      'blocked': {},
      'done': {},
    };

    const nextState = transitions[this.currentState]?.[trigger];
    if (nextState) {
      this.currentState = nextState;
      return true;
    }
    return false;
  }

  getState(): TaskState {
    return this.currentState;
  }

  setState(state: TaskState): void {
    this.currentState = state;
  }
}

/**
 * Agent 状态机
 */
export class AgentFSM {
  private agentId: string;
  private currentState: AgentState;

  constructor(agentId: string, initialState: AgentState = 'idle') {
    this.agentId = agentId;
    this.currentState = initialState;
  }

  transition(trigger: string): boolean {
    const transitions: Record<AgentState, Record<string, AgentState>> = {
      'idle': { 'dispatch_ack': 'reserved' },
      'reserved': { 'task_execution_started': 'running' },
      'running': {
        'agent_step_completed': 'running',
        'task_execution_result_success': 'idle',
        'task_execution_result_failure': 'error',
      },
      'error': { 'recover_or_reset': 'idle' },
      'released': { 'dispatch_ack': 'reserved' },
    };

    const nextState = transitions[this.currentState]?.[trigger];
    if (nextState) {
      this.currentState = nextState;
      return true;
    }
    return false;
  }

  getState(): AgentState {
    return this.currentState;
  }

  setState(state: AgentState): void {
    this.currentState = state;
  }
}

// 导出单例管理器
export const workflowFSMManager = new Map<string, WorkflowFSM>();

export function getOrCreateWorkflowFSM(config: FSMConfig): WorkflowFSM {
  const existing = workflowFSMManager.get(config.workflowId);
  if (existing) return existing;

  const fsm = new WorkflowFSM(config);
  workflowFSMManager.set(config.workflowId, fsm);
  return fsm;
}

export function removeWorkflowFSM(workflowId: string): void {
  workflowFSMManager.delete(workflowId);
}
