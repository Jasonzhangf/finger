/**
 * Operation Block 集成测试
 * 
 * 测试目标：
 * 1. OperationBlock 完整生命周期（创建、持久化、恢复）
 * 2. 发送 Operation -> handler 执行 -> 完成/失败
 * 3. 幂等性验证（重复发送不重复执行）
 * 4. 重启后自动恢复 pending operations
 * 5. 过期 operation 的清理（超过 1 小时）
 * 6. handler 注册与触发
 * 7. 日志持久化与加载
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OperationBlock, createOperationBlock } from '../../../src/blocks/operation-block/index.js';
import { OpType, createOperation, generateOpId, resolveOperationLogPath } from '../../../src/common/operation-types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('OperationBlock Integration Tests', () => {
  let operationBlock: OperationBlock;
  let testLogPath: string;
  let testRuntimeDir: string;

  beforeEach(() => {
    // 创建临时测试目录
    testRuntimeDir = path.join(os.tmpdir(), `finger-test-${Date.now()}`);
    fs.mkdirSync(testRuntimeDir, { recursive: true });
    testLogPath = path.join(testRuntimeDir, 'operation-log.jsonl');

    // 创建 OperationBlock，使用临时路径
    operationBlock = createOperationBlock('test-operation', {
      enablePersistence: true,
      maxLogSize: 1000,
    });

    // 覆盖 logPath（因为 OperationBlock 内部使用固定路径）
    // @ts-expect-error - 测试需要覆盖私有属性
    operationBlock.logPath = testLogPath;
    // @ts-expect-error
    operationBlock.operationLog = [];
    // @ts-expect-error
    operationBlock.pendingOps.clear();
  });

  afterEach(() => {
    // 清理临时目录
    if (fs.existsSync(testRuntimeDir)) {
      fs.rmSync(testRuntimeDir, { recursive: true, force: true });
    }
  });

  describe('基本生命周期', () => {
    it('创建 OperationBlock 并发送 Operation', async () => {
      const op = createOperation(
        OpType.EPIC_ASSIGN,
        'finger-system-agent',
        'finger-project-agent',
        { epicId: 'test-epic-1' }
      );

      const result = await operationBlock.execute('send', op);
      
      expect(result).toHaveProperty('sent', true);
      expect(result).toHaveProperty('opId', op.opId);
      
      // 查询历史
      const history = await operationBlock.execute('history', {});
      expect(history).toHaveLength(1);
    });

    it('完成 Operation', async () => {
      const op = createOperation(
        OpType.EPIC_CLAIM,
        'finger-project-agent',
        'finger-system-agent',
        { epicId: 'test-epic-2' }
      );

      await operationBlock.execute('send', op);
      
      const result = await operationBlock.execute('complete', {
        opId: op.opId,
        result: { claimed: true }
      });

      expect(result).toHaveProperty('completed', true);
      
      // 查询 pending（应该为空）
      const pending = await operationBlock.execute('pending', {});
      expect(pending).toHaveLength(0);
    });

    it('失败 Operation', async () => {
      const op = createOperation(
        OpType.EPIC_START,
        'finger-system-agent',
        'finger-project-agent',
        { epicId: 'test-epic-3' }
      );

      await operationBlock.execute('send', op);
      
      const result = await operationBlock.execute('fail', {
        opId: op.opId,
        error: 'Agent not available'
      });

      expect(result).toHaveProperty('failed', true);
      
      // 查询历史，状态应为 failed
      const history = await operationBlock.execute('history', {});
      const failedOp = (history as any[]).find(o => o.opId === op.opId);
      expect(failedOp?.status).toBe('failed');
      expect(failedOp?.error).toBe('Agent not available');
    });
  });

  describe('幂等性验证', () => {
    it('重复发送相同 opId 的 Operation 不重复执行', async () => {
      const opId = generateOpId();
      const op = {
        ...createOperation(
          OpType.EPIC_ASSIGN,
          'finger-system-agent',
          'finger-project-agent',
          { epicId: 'test-epic-4' }
        ),
        opId, // 强制使用相同 opId
      };

      // 第一次发送
      const result1 = await operationBlock.execute('send', op);
      expect(result1).toHaveProperty('sent', true);
      expect(result1).not.toHaveProperty('duplicate');

      // 第二次发送（相同 opId）
      const result2 = await operationBlock.execute('send', op);
      expect(result2).toHaveProperty('sent', false);
      expect(result2).toHaveProperty('duplicate', true);

      // 历史应该只有一条
      const history = await operationBlock.execute('history', {});
      expect(history).toHaveLength(1);
    });
  });

  describe('Handler 注册与触发', () => {
    it('注册 handler 并在发送时触发', async () => {
      const handlerResults: any[] = [];
      
      // 注册 handler
      operationBlock.registerHandler(OpType.EPIC_ASSIGN, async (op) => {
        handlerResults.push(op);
        return { success: true, result: { assigned: true } };
      });

      const op = createOperation(
        OpType.EPIC_ASSIGN,
        'finger-system-agent',
        'finger-project-agent',
        { epicId: 'test-epic-5' }
      );

      await operationBlock.execute('send', op);

      // 等待 handler 异步执行
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(handlerResults).toHaveLength(1);
      expect(handlerResults[0].epicId).toBe('test-epic-5');
    });

    it('handler 失败时 Operation 标记为 failed', async () => {
      operationBlock.registerHandler(OpType.EPIC_START, async (op) => {
        return { success: false, error: 'Handler execution failed' };
      });

      const op = createOperation(
        OpType.EPIC_START,
        'finger-system-agent',
        'finger-project-agent',
        { epicId: 'test-epic-6' }
      );

      await operationBlock.execute('send', op);

      // 等待 handler 异步执行
      await new Promise(resolve => setTimeout(resolve, 100));

      const history = await operationBlock.execute('history', {});
      const failedOp = (history as any[]).find(o => o.opId === op.opId);
      expect(failedOp?.status).toBe('failed');
      expect(failedOp?.error).toBe('Handler execution failed');
    });
  });

  describe('持久化与恢复', () => {
    it('Operation 持久化到日志文件', async () => {
      const op = createOperation(
        OpType.EPIC_ASSIGN,
        'finger-system-agent',
        'finger-project-agent',
        { epicId: 'test-epic-7' }
      );

      await operationBlock.execute('send', op);

      // 触发持久化（通过调用私有方法）
      // @ts-expect-error
      operationBlock.rewriteLog();

      // 验证日志文件存在且有内容
      expect(fs.existsSync(testLogPath)).toBe(true);
      const content = fs.readFileSync(testLogPath, 'utf-8');
      expect(content).toContain(op.opId);
    });

    it('重启后从日志恢复 pending operations', async () => {
      // 创建多个 pending operations
      const op1 = createOperation(
        OpType.EPIC_ASSIGN,
        'finger-system-agent',
        'finger-project-agent',
        { epicId: 'test-epic-8' }
      );
      const op2 = createOperation(
        OpType.EPIC_CLAIM,
        'finger-project-agent',
        'finger-system-agent',
        { epicId: 'test-epic-9' }
      );

      await operationBlock.execute('send', op1);
      await operationBlock.execute('send', op2);

      // 持久化
      // @ts-expect-error
      operationBlock.rewriteLog();

      // 创建新的 OperationBlock（模拟重启）
      const newBlock = createOperationBlock('test-operation-2', {
        enablePersistence: true,
      });
      // @ts-expect-error
      newBlock.logPath = testLogPath;
      // @ts-expect-error
      newBlock.loadLog();

      // 验证恢复的 pending operations
      const pending = await newBlock.execute('pending', {});
      expect(pending).toHaveLength(2);
    });

    it('过期的 pending operation 不恢复（超过 1 小时）', async () => {
      // 创建一个过期的 operation（createdAt 设置为 2 小时前）
      const expiredOp = {
        ...createOperation(
          OpType.EPIC_ASSIGN,
          'finger-system-agent',
          'finger-project-agent',
          { epicId: 'test-epic-10' }
        ),
        createdAt: Date.now() - 2 * 60 * 60 * 1000, // 2 小时前
        status: 'pending',
      };

      await operationBlock.execute('send', expiredOp);
      // @ts-expect-error
      operationBlock.rewriteLog();

      // 创建新的 OperationBlock 并触发恢复
      const newBlock = createOperationBlock('test-operation-3');
      // @ts-expect-error
      newBlock.logPath = testLogPath;
      // @ts-expect-error
      newBlock.loadLog();
      // @ts-expect-error
      newBlock.autoRecoverPendingOperations();

      // 过期的 operation 应该被标记为 failed
      const history = await newBlock.execute('history', {});
      const failedOp = (history as any[]).find(o => o.opId === expiredOp.opId);
      expect(failedOp?.status).toBe('failed');
      expect(failedOp?.error).toBe('expired_on_recovery');

      // pending 应该为空（过期的不恢复）
      const pending = await newBlock.execute('pending', {});
      expect(pending).toHaveLength(0);
    });
  });

  describe('状态查询', () => {
    it('查询特定类型的历史', async () => {
      const op1 = createOperation(OpType.EPIC_ASSIGN, 'a', 'b', { epicId: 'e1' });
      const op2 = createOperation(OpType.EPIC_CLAIM, 'b', 'a', { epicId: 'e2' });
      const op3 = createOperation(OpType.EPIC_ASSIGN, 'a', 'c', { epicId: 'e3' });

      await operationBlock.execute('send', op1);
      await operationBlock.execute('send', op2);
      await operationBlock.execute('send', op3);

      const assignHistory = await operationBlock.execute('history', { type: OpType.EPIC_ASSIGN });
      expect(assignHistory).toHaveLength(2);

      const claimHistory = await operationBlock.execute('history', { type: OpType.EPIC_CLAIM });
      expect(claimHistory).toHaveLength(1);
    });

    it('查询 pending operations', async () => {
      const op1 = createOperation(OpType.EPIC_ASSIGN, 'a', 'b', { epicId: 'e1' });
      const op2 = createOperation(OpType.EPIC_CLAIM, 'b', 'a', { epicId: 'e2' });

      await operationBlock.execute('send', op1);
      await operationBlock.execute('send', op2);
      await operationBlock.execute('complete', { opId: op1.opId });

      const pending = await operationBlock.execute('pending', {});
      expect(pending).toHaveLength(1);
      expect((pending as any[])[0].opId).toBe(op2.opId);
    });
  });
});
