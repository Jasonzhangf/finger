/**
 * Loop 循环类型定义
 * 支持 Epic 三阶段（Plan/Design/Execution）的循环生命周期管理
 */



// =============================================================================
// 循环节点类型
// =============================================================================

export type LoopNodeType = 'orch' | 'review' | 'exec' | 'user';
export type LoopNodeStatus = 'waiting' | 'running' | 'done' | 'failed';

export interface LoopNode {
  id: string;
  type: LoopNodeType;
  status: LoopNodeStatus;
  title: string;
  text: string;
  agentId?: string;
  userId?: string;
  timestamp: string;
  
  // 资源分配信息
  resourceAllocation?: {
    allocated: string[];
    released?: string[];
  };
  
  // 额外元数据
  metadata?: Record<string, unknown>;
}

// =============================================================================
// 循环类型
// =============================================================================

export type LoopPhase = 'plan' | 'design' | 'execution';
export type LoopStatus = 'queue' | 'running' | 'history';
export type LoopResult = 'success' | 'failed' | undefined;

export interface Loop {
  id: string;
  epicId: string;
  phase: LoopPhase;
  status: LoopStatus;
  result?: LoopResult;
  nodes: LoopNode[];
  createdAt: string;
  completedAt?: string;
  
  // 来源循环（如果是变更触发）
  sourceLoopId?: string;
  
  // 待执行任务队列（Design 阶段产生）
  taskQueue?: TaskDefinition[];
}

// =============================================================================
// 任务定义
// =============================================================================

export interface TaskDefinition {
  id: string;
  description: string;
  requiredCapabilities?: string[];
  estimatedDuration?: number;
  dependencies?: string[];
  priority?: number;
}

// =============================================================================
// Epic 任务流
// =============================================================================

export interface EpicTaskFlow {
  id: string;
  title: string;
  status: LoopPhase | 'completed' | 'failed';
  
  // 各阶段历史
  planHistory: Loop[];
  designHistory: Loop[];
  executionHistory: Loop[];
  
  // 当前执行
  runningLoop?: Loop;
  
  // 待执行队列
  queue: Loop[];
  
  // 当前资源分配
  activeAllocations?: Map<string, string[]>; // taskId -> resourceIds
}

// =============================================================================
// 用户交互
// =============================================================================

export interface PendingUserInput {
  question: string;
  options?: string[];
  context: string;
  loopId: string;
  nodeId: string;
}

// =============================================================================
// 资源分配
// =============================================================================

export interface ResourceAllocationInfo {
  taskId: string;
  resources: string[];
  status: 'allocated' | 'executing' | 'released';
  allocatedAt: string;
  releasedAt?: string;
  reason?: string;
}

// =============================================================================
// 上下文压缩
// =============================================================================

export interface ContextWindow {
  maxTokens: number;
  usedTokens: number;
  compressionThreshold: number;
}

export interface CompressedContext {
  originalTokens: number;
  compressedTokens: number;
  summary: string;
  preservedCycles: number; // 保留最近 N 个循环
  compressedAt: string;
}

// =============================================================================
// Loop 管理器接口
// =============================================================================

export interface LoopManager {
  // 创建循环
  createLoop(epicId: string, phase: LoopPhase, sourceLoopId?: string): Loop;
  
  // 添加节点
  addNode(loopId: string, node: Omit<LoopNode, 'id' | 'timestamp'>): LoopNode;
  
  // 更新节点状态
  updateNodeStatus(loopId: string, nodeId: string, status: LoopNodeStatus): void;
  
  // 完成循环
  completeLoop(loopId: string, result: LoopResult): Loop;
  
  // 入队新循环
  queueLoop(loop: Loop): void;
  
  // 启动循环
  startLoop(loopId: string): Loop;
  
  // 获取 Epic 的任务流
  getTaskFlow(epicId: string): EpicTaskFlow | undefined;
  
  // 获取所有活跃循环
  getActiveLoops(): Loop[];
  
  // 获取等待用户输入
  getPendingUserInput(epicId: string): PendingUserInput | undefined;
}

// =============================================================================
// 并行 Epic 预留
// =============================================================================

export interface ParallelEpicConfig {
  maxConcurrentEpics: number;
  resourceAllocationStrategy: 'fair' | 'priority' | 'demand-based';
}

export interface EpicScheduler {
  mode: 'serial' | 'parallel';
  config?: ParallelEpicConfig;
  
  // 调度下一个 Epic
  scheduleNext?(): string | undefined; // 返回 epicId
}
