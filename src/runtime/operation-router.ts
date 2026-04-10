import type { Operation, AgentPath } from '../protocol/operation-types.js';
import { AgentPathUtils } from '../protocol/operation-types.js';
import { CancellationToken } from './cancellation-token.js';
import { logger } from '../core/logger.js';

export interface OperationRouterDeps {
  eventBus: { emit: (event: unknown) => Promise<void> };
  dispatchOperation: (op: Operation, cancellationToken: CancellationToken) => Promise<{ ok: boolean; dispatchId?: string; error?: string }>;
}

interface ActiveOperationEntry {
  op: Operation;
  cancellationToken: CancellationToken;
}

/**
 * OperationRouter - Operation 路由器（唯一真源）
 *
 * 职责：
 * 1. 验证 Operation 必填字段（opId, from, to, intent, payload, timestamp）
 * 2. 验证 AgentPath 格式（使用 AgentPathUtils.isValid）
 * 3. 幂等处理（重复 Operation 直接返回 ok）
 * 4. 处理 interrupt/control_command
 * 5. 创建 CancellationToken 并传播
 * 6. 调用 dispatchOperation 执行
 *
 * @see Docs/operation-event-communication-architecture.md
 */
export class OperationRouter {
  private activeOperations = new Map<string, ActiveOperationEntry>();
  private log = logger.module('OperationRouter');

  constructor(private deps: OperationRouterDeps) {}

  /**
   * 路由 Operation
   *
   * 步骤：
   * 1. 验证 AgentPath 格式（from/to）
   * 2. 幂等检查（重复 opId）
   * 3. 处理 interrupt/control_command（优先）
   * 4. 创建 CancellationToken
   * 5. 调用 dispatchOperation
   * 6. 清理 activeOperations
   */
  async routeOperation(op: Operation): Promise<{ ok: boolean; error?: string }> {
    this.log.info('Routing operation', { opId: op.opId, from: op.from, to: op.to, intent: op.intent });

    // 1. 验证 AgentPath 格式
    if (!AgentPathUtils.isValid(op.from)) {
      this.log.error('Invalid from path', undefined, { opId: op.opId, path: op.from });
      return { ok: false, error: `Invalid 'from' path: ${op.from}. Must be valid AgentPath starting with /root` };
    }
    if (!AgentPathUtils.isValid(op.to)) {
      this.log.error('Invalid to path', undefined, { opId: op.opId, path: op.to });
      return { ok: false, error: `Invalid 'to' path: ${op.to}. Must be valid AgentPath starting with /root` };
    }

    // 2. 幂等检查
    const existing = this.activeOperations.get(op.opId);
    if (existing) {
      this.log.warn('Duplicate operation idempotent skip', { opId: op.opId });
      return { ok: true };
    }

    // 3. 处理 interrupt/control_command
    if (op.intent === 'interrupt' || op.intent === 'control_command') {
      const handled = this.handleControlOperation(op);
      if (handled) {
        this.log.info('Control operation handled', { opId: op.opId, intent: op.intent });
        return { ok: true };
      }
    }

    // 4. 创建 CancellationToken
    const cancellationToken = new CancellationToken();
    this.activeOperations.set(op.opId, { op, cancellationToken });

    try {
      // 5. 调用 dispatchOperation
      const result = await this.deps.dispatchOperation(op, cancellationToken);
      if (!result.ok) {
        this.log.error('Operation dispatch failed', undefined, { opId: op.opId, error: result.error });
      } else {
        this.log.info('Operation dispatched', { opId: op.opId, dispatchId: result.dispatchId });
      }
      return { ok: result.ok, error: result.error };
    } finally {
      // 6. 清理 activeOperations
      this.activeOperations.delete(op.opId);
    }
  }

  /**
   * 取消 Operation
   *
   * 用于外部取消请求（如用户中断、超时）
   */
  cancelOperation(opId: string, reason?: string): boolean {
    const entry = this.activeOperations.get(opId);
    if (!entry) {
      this.log.warn('Cannot cancel: operation not found', { opId });
      return false;
    }
    entry.cancellationToken.cancel(reason ?? `Operation ${opId} cancelled by caller`);
    this.log.info('Operation cancelled', { opId, reason });
    return true;
  }

  /**
   * 获取活跃 Operation 数量
   */
  getActiveOpCount(): number {
    return this.activeOperations.size;
  }

  /**
   * 获取活跃 Operation
   */
  getActiveOperation(opId: string): Operation | undefined {
    return this.activeOperations.get(opId)?.op;
  }

  /**
   * 获取所有活跃 Operations
   */
  getActiveOperations(): Operation[] {
    return Array.from(this.activeOperations.values()).map(entry => entry.op);
  }

  /**
   * 处理控制类 Operation（interrupt/control_command）
   *
   * 遍历活跃 Operations，找到匹配目标的并取消
   */
  private handleControlOperation(op: Operation): boolean {
    for (const [activeOpId, entry] of this.activeOperations) {
      // 匹配目标：to 相同且不是控制类 Operation
      if (
        entry.op.to === op.to &&
        entry.op.intent !== 'interrupt' &&
        entry.op.intent !== 'control_command'
      ) {
        entry.cancellationToken.cancel(`Interrupted by control operation ${op.opId}`);
        this.log.info('Active operation interrupted', { targetOpId: activeOpId, controlOpId: op.opId });
        return true;
      }
    }
    return false;
  }
}
