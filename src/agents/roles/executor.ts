import { Agent, AgentConfig } from '../agent.js';
import { BdTools } from '../shared/bd-tools.js';
import type { TaskAssignment } from '../protocol/schema.js';

export interface ExecutorRoleConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
}

export type ExecutorState = 'idle' | 'claiming' | 'thinking' | 'acting' | 'observing' | 'completed' | 'failed';

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
}

const DEFAULT_SYSTEM_PROMPT = `你是一个任务执行者 Agent，负责完成具体的执行任务。

你的职责:
1. 理解任务要求，分析需要做什么
2. 使用 ReAct 循环: Thought -> Action -> Observation
3. 完成代码编写、文件操作、命令执行等任务
4. 返回执行结果和总结

工具使用原则:
- file.read: 读取文件内容
- file.write: 写入/创建文件
- file.list: 列出目录
- shell.exec: 执行命令
- bd.query: 查询任务状态

执行完成后，返回 JSON 格式的结果。`;

export class ExecutorRole {
  private config: ExecutorRoleConfig;
  private agent: Agent;
  private bdTools: BdTools;
  private state: ExecutorState = 'idle';

  constructor(config: ExecutorRoleConfig) {
    this.config = config;
    const agentConfig: AgentConfig = {
      id: config.id,
      name: config.name,
      mode: config.mode,
      provider: 'iflow',
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      cwd: config.cwd,
    };
    this.agent = new Agent(agentConfig);
    this.bdTools = new BdTools(config.cwd);
  }

  async initialize(): Promise<void> {
    await this.agent.initialize();
  }

  async disconnect(): Promise<void> {
    await this.agent.disconnect();
  }

  getState(): ExecutorState {
    return this.state;
  }

  async execute(task: TaskAssignment): Promise<ExecutionResult> {
    const startTime = Date.now();
    this.state = 'claiming';

    if (task.bdTaskId) {
      await this.bdTools.updateStatus(task.bdTaskId, 'in_progress');
      await this.bdTools.addComment(task.bdTaskId, `[${this.config.id}] 开始执行任务`);
    }

    try {
      this.state = 'thinking';
      const thinkPrompt = `分析以下任务，制定执行计划:

任务: ${task.description}
可用工具: ${task.tools.join(', ')}

请输出执行步骤和需要的工具。`;

      const thought = await this.agent.execute(thinkPrompt);
      if (!thought.success) {
        throw new Error('Thought failed: ' + thought.error);
      }

      this.state = 'acting';
      const actionPrompt = `基于以下分析执行任务:

分析结果:
${thought.output}

任务: ${task.description}

请执行并完成此任务，返回结果。`;

      const action = await this.agent.execute(actionPrompt);

      this.state = 'completed';
      const duration = Date.now() - startTime;

      let output = action.output;
      try {
        const jsonMatch = action.output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          output = JSON.stringify(result, null, 2);
        }
      } catch {
        // Use raw output
      }

      if (task.bdTaskId) {
        await this.bdTools.closeTask(task.bdTaskId, '执行成功', [
          { type: 'result', content: output },
        ]);
      }

      return { success: true, output, duration };

    } catch (error) {
      this.state = 'failed';
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (task.bdTaskId) {
        await this.bdTools.updateStatus(task.bdTaskId, 'blocked');
        await this.bdTools.addComment(task.bdTaskId, '[' + this.config.id + '] 执行失败: ' + errorMsg);
      }

      return { success: false, output: '', error: errorMsg, duration };
    } finally {
      this.state = 'idle';
    }
  }
}

export type { ExecutorRoleConfig };
