#!/usr/bin/env node
/**
 * bd 集成端到端测试脚本
 * 
 * 运行方式:
 *   npx tsx scripts/test-bd-integration.ts
 * 
 * 此脚本测试:
 * 1. Orchestrator 创建 Epic
 * 2. 拆解任务并创建子任务
 * 3. Executor 执行并更新 bd 状态
 * 4. 验证 Epic 进度
 */

import { BdTools } from '../src/agents/shared/bd-tools.js';
import { OrchestratorRole, OrchestratorState } from '../src/agents/roles/orchestrator.js';
import { ExecutorRole, ExecutorState } from '../src/agents/roles/executor.js';
import { ToolRegistry } from '../src/agents/shared/tool-registry.js';

async function main() {
  console.log('=== bd 集成端到端测试 ===\n');

  const bdTools = new BdTools();

  // 1. 测试创建 Epic
  console.log('1. 创建编排 Epic...');
  const epic = await bdTools.createTask({
    title: '测试: 创建一个简单的 Node.js 脚本',
    type: 'epic',
    priority: 0,
    labels: ['orchestration', 'test'],
  });
  console.log(`   ✓ Epic 创建: ${epic.id}`);

  // 2. 创建子任务
  console.log('\n2. 创建子任务...');
  const subTasks = await Promise.all([
    bdTools.createTask({
      title: '创建项目目录',
      type: 'task',
      parent: epic.id,
      priority: 1,
      labels: ['parallel'],
    }),
    bdTools.createTask({
      title: '编写 index.js',
      type: 'task',
      parent: epic.id,
      priority: 1,
      labels: ['main-path'],
    }),
    bdTools.createTask({
      title: '测试脚本',
      type: 'task',
      parent: epic.id,
      priority: 2,
      labels: ['parallel'],
    }),
  ]);
  console.log(`   ✓ 创建了 ${subTasks.length} 个子任务`);
  for (const t of subTasks) {
    console.log(`     - ${t.id}: ${t.title}`);
  }

  // 3. 模拟执行者领取任务
  console.log('\n3. 模拟执行者领取并完成任务...');
  for (const task of subTasks) {
    await bdTools.updateStatus(task.id, 'in_progress');
    await bdTools.assignTask(task.id, 'executor-test');
    await bdTools.addComment(task.id, `[executor-test] 开始执行`);
    
    // 模拟执行时间
    await new Promise(r => setTimeout(r, 100));
    
    await bdTools.closeTask(
      task.id,
      '任务完成',
      [
        { type: 'file', path: `/tmp/test-project/${task.title.replace(/\s+/g, '-').toLowerCase()}.done` },
        { type: 'result', content: `成功: ${task.title}` },
      ]
    );
    console.log(`   ✓ ${task.id} 完成`);
  }

  // 4. 检查 Epic 进度
  console.log('\n4. 检查 Epic 进度...');
  const progress = await bdTools.getEpicProgress(epic.id);
  console.log(`   总计: ${progress.total}`);
  console.log(`   已完成: ${progress.completed}`);
  console.log(`   进行中: ${progress.inProgress}`);
  console.log(`   阻塞: ${progress.blocked}`);
  console.log(`   待开始: ${progress.open}`);

  // 5. 关闭 Epic
  if (progress.completed === progress.total) {
    await bdTools.closeTask(
      epic.id,
      '所有子任务已完成，Epic 关闭',
      [
        { type: 'summary', content: `完成 ${progress.completed} 个子任务` },
        { type: 'stats', content: JSON.stringify(progress) },
      ]
    );
    console.log('\n✓ Epic 已关闭');
  }

  // 6. 查询 bd 验证
  console.log('\n5. 查询 bd 验证任务...');
  const epicTasks = await bdTools.getEpicTasks(epic.id);
  console.log(`   Epic ${epic.id} 下的任务:`);
  for (const t of epicTasks) {
    console.log(`     - ${t.id}: [${t.status}] ${t.title}`);
  }

  console.log('\n=== 测试完成 ===');
  console.log(`\n可以在 bd 中查看:`);
  console.log(`  bd --no-db show ${epic.id}`);
  console.log(`  bd --no-db epic status ${epic.id}`);
}

main().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
