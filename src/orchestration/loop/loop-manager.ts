/**
 * LoopManager - 循环生命周期管理器
 * 管理单个 Epic 的循环创建、节点生长、状态转换
 */

import { globalEventBus } from '../../runtime/event-bus.js';
import { resourcePool } from '../resource-pool.js';
import type {
  Loop,
  LoopNode,
  LoopPhase,
  
  LoopResult,
  LoopNodeStatus,
  EpicTaskFlow,
  
  PendingUserInput,
  LoopManager as ILoopManager,
  ContextWindow,
  CompressedContext,
} from './types.js';
import type {
  LoopCreatedEvent,
  LoopStartedEvent,
  LoopNodeUpdatedEvent,
  LoopNodeCompletedEvent,
  LoopCompletedEvent,
  LoopQueuedEvent,
  EpicPhaseTransitionEvent,
  EpicUserInputRequiredEvent,
  ResourceAllocatedEvent,
  ResourceReleasedEvent,
} from './events.js';

export class LoopManager implements ILoopManager {
  private taskFlows = new Map<string, EpicTaskFlow>();
  private pendingUserInputs = new Map<string, PendingUserInput>();
  private contextWindows = new Map<string, ContextWindow>();
  
  // 循环缓存：存储所有创建的循环，便于快速查找
  private loopCache = new Map<string, Loop>();
  
  // 默认上下文窗口配置
  private readonly defaultContextWindow: ContextWindow = {
    maxTokens: 128000,
    usedTokens: 0,
    compressionThreshold: 100000, // 78% 触发压缩
  };
  
  // 压缩配置
  private readonly preservedCycles = 2; // 保留最近 2 个循环原文

  constructor() {
    // 初始化
  }

  // ===========================================================================
  // 循环管理
  // ===========================================================================

  createLoop(epicId: string, phase: LoopPhase, sourceLoopId?: string): Loop {
    const seq = this.getNextLoopSeq(epicId, phase);
    const loop: Loop = {
      id: `L-${epicId}-${phase}-${seq}`,
      epicId,
      phase,
      status: 'queue',
      nodes: [],
      createdAt: new Date().toISOString(),
      sourceLoopId,
    };

    // 缓存循环
    this.loopCache.set(loop.id, loop);

    // 发射事件
    this.emitLoopCreated(loop);

    return loop;
  }

  queueLoop(loop: Loop): void {
    const taskFlow = this.getOrCreateTaskFlow(loop.epicId);
    loop.status = 'queue';
    taskFlow.queue.push(loop);

    // 发射事件
    this.emitLoopQueued(loop);
  }

  startLoop(loopId: string): Loop {
    const { loop, taskFlow } = this.findLoop(loopId);
    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    loop.status = 'running';
    
    // 从队列移到运行
    taskFlow.queue = taskFlow.queue.filter(l => l.id !== loopId);
    taskFlow.runningLoop = loop;

    // 发射事件
    this.emitLoopStarted(loop);

    return loop;
  }

  completeLoop(loopId: string, result: LoopResult): Loop {
    const { loop, taskFlow } = this.findLoop(loopId);
    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    loop.status = 'history';
    loop.result = result;
    loop.completedAt = new Date().toISOString();

    // 移入历史
    if (loop.phase === 'plan') {
      taskFlow.planHistory.push(loop);
    } else if (loop.phase === 'design') {
      taskFlow.designHistory.push(loop);
    } else {
      taskFlow.executionHistory.push(loop);
    }

    // 清除运行状态
    if (taskFlow.runningLoop?.id === loopId) {
      taskFlow.runningLoop = undefined;
    }

    // 发射事件
    this.emitLoopCompleted(loop, result);

    // 检查上下文压缩
    this.checkContextCompression(loop.epicId);

    return loop;
  }

  // ===========================================================================
  // 节点管理
  // ===========================================================================

  addNode(loopId: string, node: Omit<LoopNode, 'id' | 'timestamp'>): LoopNode {
    const { loop } = this.findLoop(loopId);
    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    const fullNode: LoopNode = {
      ...node,
      id: `N-${loopId}-${loop.nodes.length + 1}`,
      timestamp: new Date().toISOString(),
    };

    loop.nodes.push(fullNode);

    // 发射事件
    this.emitNodeUpdated(loop, fullNode);

    return fullNode;
  }

  updateNodeStatus(loopId: string, nodeId: string, status: LoopNodeStatus): void {
    const { loop } = this.findLoop(loopId);
    if (!loop) {
      throw new Error(`Loop not found: ${loopId}`);
    }

    const node = loop.nodes.find(n => n.id === nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const previousStatus = node.status;
    node.status = status;

    // 发射事件
    this.emitNodeUpdated(loop, node, previousStatus);

    // 如果节点完成，发射完成事件
    if (status === 'done' || status === 'failed') {
      this.emitNodeCompleted(loop, node, status === 'done' ? 'success' : 'failed');
    }
  }

  // ===========================================================================
  // 用户交互
  // ===========================================================================

  requestUserInput(epicId: string, question: string, options?: string[], context?: string): PendingUserInput {
    const taskFlow = this.getOrCreateTaskFlow(epicId);
    const loop = taskFlow.runningLoop;
    if (!loop) {
      throw new Error(`No running loop for epic: ${epicId}`);
    }

    // 添加用户节点
    const node = this.addNode(loop.id, {
      type: 'user',
      status: 'waiting',
      title: '用户输入',
      text: question,
    });

    const pending: PendingUserInput = {
      question,
      options,
      context: context || '',
      loopId: loop.id,
      nodeId: node.id,
    };

    this.pendingUserInputs.set(epicId, pending);

    // 发射事件
    this.emitUserInputRequired(epicId, pending);

    return pending;
  }

  receiveUserInput(epicId: string, response: string): void {
    const pending = this.pendingUserInputs.get(epicId);
    if (!pending) {
      throw new Error(`No pending user input for epic: ${epicId}`);
    }

    // 更新节点状态
    this.updateNodeStatus(pending.loopId, pending.nodeId, 'done');

    // 清除待处理
    this.pendingUserInputs.delete(epicId);
  }

  getPendingUserInput(epicId: string): PendingUserInput | undefined {
    return this.pendingUserInputs.get(epicId);
  }

  // ===========================================================================
  // 资源分配
  // ===========================================================================

  allocateResources(taskId: string, requirements: Array<{ type: string; capabilities?: string[] }>): {
    success: boolean;
    allocated?: string[];
    error?: string;
  } {
    const result = resourcePool.allocateResources(taskId, requirements.map(r => ({
      type: r.type as 'executor' | 'orchestrator' | 'reviewer',
      capabilities: r.capabilities,
    })));

    if (result.success && result.allocatedResources) {
      // 发射事件
      this.emitResourceAllocated(taskId, result.allocatedResources);
    }

    return result;
  }

  releaseResources(taskId: string, reason: 'completed' | 'failed' | 'blocked' | 'cancelled'): void {
    resourcePool.releaseResources(taskId, reason);

    const allocation = resourcePool.getAllocation(taskId);
    if (allocation) {
      // 发射事件
      this.emitResourceReleased(taskId, allocation.allocatedResources, reason);
    }
  }

  // ===========================================================================
  // 阶段转换
  // ===========================================================================

  transitionPhase(epicId: string, to: LoopPhase | 'completed' | 'failed', reason: string): void {
    const taskFlow = this.getOrCreateTaskFlow(epicId);
    const from = taskFlow.status;
    taskFlow.status = to;

    // 发射事件
    this.emitPhaseTransition(epicId, from, to, reason);
  }

  // ===========================================================================
  // 上下文压缩
  // ===========================================================================

  checkContextCompression(epicId: string): void {
    const contextWindow = this.contextWindows.get(epicId) || { ...this.defaultContextWindow };
    
    // 双条件触发：循环完成 + token 阈值
    const taskFlow = this.getTaskFlow(epicId);
    if (!taskFlow) return;

    const totalCycles = 
      taskFlow.planHistory.length + 
      taskFlow.designHistory.length + 
      taskFlow.executionHistory.length;

    const cycleTrigger = totalCycles > this.preservedCycles;
    const tokenTrigger = contextWindow.usedTokens > contextWindow.compressionThreshold;

    if (cycleTrigger && tokenTrigger) {
      this.compressContext(epicId);
    }
  }

  compressContext(epicId: string): CompressedContext {
    const taskFlow = this.getTaskFlow(epicId);
    if (!taskFlow) {
      throw new Error(`TaskFlow not found: ${epicId}`);
    }

    // 计算需要压缩的历史
    const allHistory = [
      ...taskFlow.planHistory,
      ...taskFlow.designHistory,
      ...taskFlow.executionHistory,
    ];

    const toCompress = allHistory.slice(0, -this.preservedCycles);
    const toPreserve = allHistory.slice(-this.preservedCycles);

    // 生成摘要（这里简化处理，实际需要 LLM 压缩）
    const summary = this.generateSummary(toCompress);

    const compressed: CompressedContext = {
      originalTokens: toCompress.length * 1000, // 估算
      compressedTokens: summary.length,
      summary,
      preservedCycles: this.preservedCycles,
      compressedAt: new Date().toISOString(),
    };

    // 更新上下文窗口
    const contextWindow = this.contextWindows.get(epicId) || { ...this.defaultContextWindow };
    contextWindow.usedTokens = compressed.compressedTokens + toPreserve.length * 1000;
    this.contextWindows.set(epicId, contextWindow);

    return compressed;
  }

  private generateSummary(loops: Loop[]): string {
    // 简化处理：提取关键决策
    const decisions: string[] = [];
    for (const loop of loops) {
      for (const node of loop.nodes) {
        if (node.type === 'orch' && node.metadata?.decision) {
          decisions.push(node.metadata.decision as string);
        }
      }
    }
    return `历史决策摘要：${decisions.join('；')}`;
  }

  // ===========================================================================
  // 查询方法
  // ===========================================================================

  getTaskFlow(epicId: string): EpicTaskFlow | undefined {
    return this.taskFlows.get(epicId);
  }

  getOrCreateTaskFlow(epicId: string): EpicTaskFlow {
    let taskFlow = this.taskFlows.get(epicId);
    if (!taskFlow) {
      taskFlow = {
        id: epicId,
        title: '',
        status: 'plan',
        planHistory: [],
        designHistory: [],
        executionHistory: [],
        queue: [],
      };
      this.taskFlows.set(epicId, taskFlow);
    }
    return taskFlow;
  }

  getActiveLoops(): Loop[] {
    const loops: Loop[] = [];
    for (const taskFlow of this.taskFlows.values()) {
      if (taskFlow.runningLoop) {
        loops.push(taskFlow.runningLoop);
      }
    }
    return loops;
  }

  // ===========================================================================
  // 私有方法
  // ===========================================================================

  private findLoop(loopId: string): { loop?: Loop; taskFlow: EpicTaskFlow } {
    // 优先从缓存查找
    const cached = this.loopCache.get(loopId);
    if (cached) {
      const taskFlow = this.getOrCreateTaskFlow(cached.epicId);
      return { loop: cached, taskFlow };
    }

    // 解析 loopId: L-{epicId}-{phase}-{seq}
    const parts = loopId.split('-');
    const epicId = parts[1];
    const taskFlow = this.getOrCreateTaskFlow(epicId);

    // 搜索所有位置
    let loop = taskFlow.runningLoop;
    if (loop?.id === loopId) {
      return { loop, taskFlow };
    }

    loop = taskFlow.queue.find(l => l.id === loopId);
    if (loop) {
      return { loop, taskFlow };
    }

    loop = [...taskFlow.planHistory, ...taskFlow.designHistory, ...taskFlow.executionHistory]
      .find(l => l.id === loopId);
    
    return { loop, taskFlow };
  }

  private getNextLoopSeq(epicId: string, phase: LoopPhase): number {
    const taskFlow = this.getOrCreateTaskFlow(epicId);
    const history = 
      phase === 'plan' ? taskFlow.planHistory :
      phase === 'design' ? taskFlow.designHistory :
      taskFlow.executionHistory;
    return history.length + 1;
  }

  // ===========================================================================
  // 事件发射
  // ===========================================================================

  private emitLoopCreated(loop: Loop): void {
    const event: LoopCreatedEvent = {
      type: 'loop.created',
      sessionId: loop.epicId,
      timestamp: new Date().toISOString(),
      epicId: loop.epicId,
      payload: { loop },
    };
    globalEventBus.emit(event as any);
  }

  private emitLoopStarted(loop: Loop): void {
    const event: LoopStartedEvent = {
      type: 'loop.started',
      sessionId: loop.epicId,
      timestamp: new Date().toISOString(),
      epicId: loop.epicId,
      loopId: loop.id,
      payload: { loopId: loop.id, phase: loop.phase },
    };
    globalEventBus.emit(event as any);
  }

  private emitNodeUpdated(loop: Loop, node: LoopNode, previousStatus?: string): void {
    const event: LoopNodeUpdatedEvent = {
      type: 'loop.node.updated',
      sessionId: loop.epicId,
      timestamp: new Date().toISOString(),
      epicId: loop.epicId,
      loopId: loop.id,
      nodeId: node.id,
      payload: { node, previousStatus },
    };
    globalEventBus.emit(event as any);
  }

  private emitNodeCompleted(loop: Loop, node: LoopNode, result: 'success' | 'failed'): void {
    const event: LoopNodeCompletedEvent = {
      type: 'loop.node.completed',
      sessionId: loop.epicId,
      timestamp: new Date().toISOString(),
      epicId: loop.epicId,
      loopId: loop.id,
      nodeId: node.id,
      payload: { result, node },
    };
    globalEventBus.emit(event as any);
  }

  private emitLoopCompleted(loop: Loop, result: LoopResult): void {
    const event: LoopCompletedEvent = {
      type: 'loop.completed',
      sessionId: loop.epicId,
      timestamp: new Date().toISOString(),
      epicId: loop.epicId,
      payload: { loop, result },
    };
    globalEventBus.emit(event as any);
  }

  private emitLoopQueued(loop: Loop): void {
    const event: LoopQueuedEvent = {
      type: 'loop.queued',
      sessionId: loop.epicId,
      timestamp: new Date().toISOString(),
      epicId: loop.epicId,
      payload: { loop, sourceLoopId: loop.sourceLoopId || '' },
    };
    globalEventBus.emit(event as any);
  }

  private emitPhaseTransition(epicId: string, from: string, to: string, reason: string): void {
    const event: EpicPhaseTransitionEvent = {
      type: 'epic.phase_transition',
      sessionId: epicId,
      timestamp: new Date().toISOString(),
      epicId,
      payload: { from: from as any, to: to as any, reason },
    };
    globalEventBus.emit(event as any);
  }

  private emitUserInputRequired(epicId: string, pending: PendingUserInput): void {
    const event: EpicUserInputRequiredEvent = {
      type: 'epic.user_input_required',
      sessionId: epicId,
      timestamp: new Date().toISOString(),
      epicId,
      payload: pending,
    };
    globalEventBus.emit(event as any);
  }

  private emitResourceAllocated(taskId: string, resources: string[]): void {
    const event: ResourceAllocatedEvent = {
      type: 'resource.allocated',
      sessionId: taskId,
      timestamp: new Date().toISOString(),
      taskId,
      payload: {
        taskId,
        resources,
        status: 'allocated',
        allocatedAt: new Date().toISOString(),
      },
    };
    globalEventBus.emit(event as any);
  }

  private emitResourceReleased(taskId: string, resources: string[], reason: string): void {
    const event: ResourceReleasedEvent = {
      type: 'resource.released',
      sessionId: taskId,
      timestamp: new Date().toISOString(),
      taskId,
      payload: {
        resources,
        reason: reason as any,
      },
    };
    globalEventBus.emit(event as any);
  }
}

// 单例
export const loopManager = new LoopManager();
