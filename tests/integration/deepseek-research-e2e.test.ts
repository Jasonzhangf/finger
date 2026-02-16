/**
 * DeepSeek 研究任务 - 复杂编排 E2E 测试
 * 
 * 任务目标：
 * 1. 搜索 DeepSeek 过去一年的新技术发布和里程碑
 * 2. 下载关键新闻和技术白皮书
 * 3. 本地进行分析
 * 4. 预估下一个发布的模型特征
 * 5. 输出一个 md 文件总结
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MessageHub } from '../../src/orchestration/message-hub.js';
import { createOrchestratorLoop } from '../../src/agents/daemon/orchestrator-loop.js';
import { createExecutorLoop } from '../../src/agents/daemon/executor-loop.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('DeepSeek Research E2E', () => {
  let hub: MessageHub;
  let orchestratorModule: ReturnType<typeof createOrchestratorLoop>['module'];
  let executorModule: ReturnType<typeof createExecutorLoop>['module'];
  let tempDir: string;
  const outputDir = '/Volumes/extension/code/finger/output/deepseek-research';

  beforeAll(async () => {
    // 创建临时目录
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-research-'));
    console.log(`\nTemp dir: ${tempDir}`);
    console.log(`Output dir: ${outputDir}`);

    // 初始化 bd
    try {
      execSync('bd init --no-db', { cwd: tempDir, stdio: 'ignore' });
    } catch {
      fs.mkdirSync(path.join(tempDir, '.beads'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.beads', 'config.yaml'),
        'mode: git-portable\n'
      );
    }

    hub = new MessageHub();

    // 创建编排者
    const orch = createOrchestratorLoop({
      id: 'orchestrator-deepseek',
      targetExecutorId: 'executor-research',
      name: 'DeepSeek Research Orchestrator',
      mode: 'auto',
      maxRounds: 10,
      cwd: tempDir,
    }, hub);
    orchestratorModule = orch.module;
    await orchestratorModule.initialize?.();

   // 创建执行者（带 web 搜索和文件操作能力）
   const exec = createExecutorLoop({
     id: 'executor-research',
     name: 'Research Executor',
     mode: 'auto',
     maxIterations: 5,
     cwd: tempDir,
      systemPrompt: `研究任务执行者。
只输出一行JSON，不要代码块，不要其他文字：
{"thought":"简短分析","action":"ACTION","params":{...}}
示例：{"thought":"搜索DeepSeek","action":"WEB_SEARCH","params":{"query":"DeepSeek V3 R1"}}
示例：{"thought":"完成","action":"COMPLETE","params":{"output":"完成"}}
可用：WEB_SEARCH|FETCH_URL|WRITE_FILE|READ_FILE|SHELL_EXEC|COMPLETE|FAIL`,
   });
   executorModule = exec.module;
   await executorModule.initialize?.();

    hub.registerOutput('orchestrator-deepseek', async (msg, cb) => {
      const result = await orchestratorModule.handle(msg, cb);
      return result;
    });

    hub.registerOutput('executor-research', async (msg, cb) => {
      const result = await executorModule.handle(msg, cb);
      return result;
    });
  }, 120000);

  afterAll(async () => {
    await orchestratorModule.destroy?.();
    await executorModule.destroy?.();
    
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('completes deepseek research task with report generation', async () => {
    const userTask = `搜索 DeepSeek 过去一年的新技术发布和里程碑，下载关键的新闻和他们发布的技术白皮书，本地进行分析，预估下一个发布的模型特征，输出一个 md 文件总结到 ${outputDir}/deepseek_analysis_report.md`;

    const result = await hub.sendToModule('orchestrator-deepseek', {
      content: userTask,
    }) as {
      success: boolean;
      result?: {
        success: boolean;
        epicId: string;
        completed?: number;
        failed?: number;
        rounds: number;
        output?: string;
      };
    };

    console.log('\n=== DeepSeek Research Result ===');
    console.log(JSON.stringify(result, null, 2));

    // 验证编排完成
    expect(result.success).toBe(true);
    
    if (result.result) {
      const { completed = 0, failed = 0, rounds, output } = result.result;
      console.log(`\nCompleted tasks: ${completed}`);
      console.log(`Failed tasks: ${failed}`);
      console.log(`Total rounds: ${rounds}`);
      console.log(`Output: ${output?.substring(0, 200)}...`);
      
      // 验证结果
      expect(failed).toBe(0);
      expect(rounds).toBeLessThanOrEqual(10);
      
      // 验证报告文件是否生成
      const reportPath = path.join(outputDir, 'deepseek_analysis_report.md');
      if (fs.existsSync(reportPath)) {
        const content = fs.readFileSync(reportPath, 'utf-8');
        console.log(`\nReport generated: ${reportPath}`);
        console.log(`Report size: ${content.length} bytes`);
        expect(content.length).toBeGreaterThan(0);
      }
    }
  }, 600000);
});
