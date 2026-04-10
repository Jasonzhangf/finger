import { describe, it, expect } from 'vitest';
import { OperationRouter } from '../../../src/runtime/operation-router.js';
import type { Operation } from '../../../src/protocol/operation-types.js';

describe('OperationRouter', () => {
  function createRouter(): {
    router: OperationRouter;
    emitCalls: unknown[];
    dispatchCalls: Operation[];
    tokenCancels: string[];
    dispatchResult: { ok: boolean; dispatchId?: string; error?: string };
  } {
    const emitCalls: unknown[] = [];
    const dispatchCalls: Operation[] = [];
    const tokenCancels: string[] = [];
    const dispatchResult = { ok: true, dispatchId: 'dispatch-1' };

    const router = new OperationRouter({
      eventBus: {
        emit: async (event: unknown) => {
          emitCalls.push(event);
        },
      },
      dispatchOperation: async (op: Operation, token: any) => {
        dispatchCalls.push(op);
        token.onCancellation((reason: string) => {
          tokenCancels.push(reason);
        });
        return dispatchResult;
      },
    });

    return { router, emitCalls, dispatchCalls, tokenCancels, dispatchResult };
  }

  it('should route operation successfully', async () => {
    const { router, dispatchCalls } = createRouter();
    const result = await router.routeOperation({
      opId: 'op-1',
      from: '/root/finger-system-agent',
      to: '/root/finger-project-agent',
      intent: 'dispatch_task',
      payload: { taskId: 'task-1' },
      timestamp: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(dispatchCalls.length).toBe(1);
    expect(dispatchCalls[0].intent).toBe('dispatch_task');
  });

  it('should reject invalid from path', async () => {
    const { router, dispatchCalls } = createRouter();
    const result = await router.routeOperation({
      opId: 'op-2',
      from: '/invalid' as any,
      to: '/root/finger-project-agent',
      intent: 'dispatch_task',
      payload: {},
      timestamp: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid');
    expect(dispatchCalls.length).toBe(0);
  });

  it('should reject invalid to path', async () => {
    const { router, dispatchCalls } = createRouter();
    const result = await router.routeOperation({
      opId: 'op-3',
      from: '/root/finger-system-agent',
      to: '/invalid' as any,
      intent: 'dispatch_task',
      payload: {},
      timestamp: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid');
    expect(dispatchCalls.length).toBe(0);
  });

  it('should idempotent skip duplicate operation while active', async () => {
    // 模拟并行调用场景：第一个调用还未完成时，第二个调用到达
    let dispatchResolve: any;
    const slowDispatchCalls: Operation[] = [];

    const slowRouter = new OperationRouter({
      eventBus: {
        emit: async () => {},
      },
      dispatchOperation: async (op: Operation, token: any) => {
        slowDispatchCalls.push(op);
        return new Promise(resolve => {
          dispatchResolve = resolve;
        });
      },
    });

    // 第一个调用（未完成）
    const promise1 = slowRouter.routeOperation({
      opId: 'op-dup-parallel',
      from: '/root/finger-system-agent',
      to: '/root/finger-project-agent',
      intent: 'dispatch_task',
      payload: { taskId: 'task-1' },
      timestamp: new Date().toISOString(),
    });

    // 此时第一个调用在 activeOperations 中
    expect(slowRouter.getActiveOpCount()).toBe(1);

    // 第二个调用（同一 opId，在第一个未完成时到达）
    const promise2 = slowRouter.routeOperation({
      opId: 'op-dup-parallel',
      from: '/root/finger-system-agent',
      to: '/root/finger-project-agent',
      intent: 'dispatch_task',
      payload: { taskId: 'task-1' },
      timestamp: new Date().toISOString(),
    });

    // 完成第一个 dispatch
    dispatchResolve({ ok: true, dispatchId: 'dispatch-1' });

    const result1 = await promise1;
    const result2 = await promise2;

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true); // 幂等返回 ok
    expect(slowDispatchCalls.length).toBe(1); // 只 dispatch 一次
  });

  it('should cancel operation', async () => {
    const { router } = createRouter();
    // 路由一个操作
    const routePromise = router.routeOperation({
      opId: 'op-cancel',
      from: '/root/finger-system-agent',
      to: '/root/finger-project-agent',
      intent: 'dispatch_task',
      payload: { taskId: 'task-1' },
      timestamp: new Date().toISOString(),
    });

    // 立即取消
    const cancelResult = router.cancelOperation('op-cancel', 'user requested');
    expect(cancelResult).toBe(true);

    const result = await routePromise;
    expect(result.ok).toBe(true);
  });

  it('should handle interrupt operation', async () => {
    const { router, dispatchCalls } = createRouter();
    // 先路由一个 dispatch_task
    const dispatchPromise = router.routeOperation({
      opId: 'op-dispatch',
      from: '/root/finger-system-agent',
      to: '/root/finger-project-agent',
      intent: 'dispatch_task',
      payload: { taskId: 'task-1' },
      timestamp: new Date().toISOString(),
    });

    // 再路由 interrupt
    const result = await router.routeOperation({
      opId: 'op-interrupt',
      from: '/root/finger-system-agent',
      to: '/root/finger-project-agent',
      intent: 'interrupt',
      payload: {},
      timestamp: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);

    await dispatchPromise;
    expect(dispatchCalls.length).toBe(1);
  });

  it('should get active operations', async () => {
    const { router } = createRouter();
    expect(router.getActiveOpCount()).toBe(0);

    const dispatchPromise = router.routeOperation({
      opId: 'op-count',
      from: '/root/finger-system-agent',
      to: '/root/finger-project-agent',
      intent: 'dispatch_task',
      payload: { taskId: 'task-1' },
      timestamp: new Date().toISOString(),
    });

    expect(router.getActiveOpCount()).toBe(1);
    const activeOps = router.getActiveOperations();
    expect(activeOps.length).toBe(1);
    expect(activeOps[0].opId).toBe('op-count');

    await dispatchPromise;
    expect(router.getActiveOpCount()).toBe(0);
  });
});
