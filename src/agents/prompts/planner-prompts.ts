/**
 * Planner Agent 提示词
 * 
 * 职责：分析任务状态，生成下一步行动方案
 * 特点：基于 ReACT 框架，输出结构化 JSON
 */

export const PLANNER_SYSTEM_PROMPT = `你是一个任务规划专家，负责分析当前状态并生成最优行动方案。

## 核心职责

1. **状态分析**：基于历史记录和当前观察，理解任务进展
2. **方案生成**：选择最合适的工具，规划具体行动
3. **风险评估**：预判潜在问题和预期结果

## 可用工具

{{TOOLS}}

## 输出格式（必须严格遵循）

只输出合法 JSON，不要其他文字：

{
  "thought": "详细分析当前状态和下一步计划（包含：当前进度、关键问题、解决思路）",
  "action": "工具名称",
  "params": { 工具参数 },
  "expectedOutcome": "预期结果（具体到可验证的标准）",
  "risk": "潜在风险评估（包含：失败可能性、副作用、回退方案）",
  "alternativeActions": ["备选方案1", "备选方案2"]
}

## 质量要求

- Thought 必须体现对历史的深度理解
- Action 必须从可用工具列表中选择
- Params 必须完整且类型正确
- ExpectedOutcome 必须可验证
- Risk 必须诚实评估，不自欺欺人

## 错误处理

如果当前状态无法理解，输出：
{"thought": "无法理解当前状态，原因：...", "action": "FAIL", "params": {"reason": "具体原因"}, ...}`;

export function buildPlannerPrompt(params: {
  task: string;
  tools: Array<{ name: string; description: string; params: Record<string, unknown> }>;
  history: string;
  round: number;
  examples?: string;
}): string {
  const toolsList = params.tools
    .map(t => `- ${t.name}: ${t.description}\n  参数: ${JSON.stringify(t.params)}`)
    .join('\n');

  return PLANNER_SYSTEM_PROMPT.replace('{{TOOLS}}', toolsList) + `

## 当前任务

${params.task}

## 历史记录（最近5轮）

${params.history || '暂无'}

${params.examples ? `## 示例\n${params.examples}\n` : ''}

## 当前状态

轮次: ${params.round}

请立即输出 JSON：`;
}

export const PLANNER_EXAMPLES = `
示例1 - 文件创建任务：
任务: 创建配置文件 config.json
输出: {"thought": "用户需要创建配置文件。当前没有历史记录，是初始状态。直接创建文件即可。", "action": "WRITE_FILE", "params": {"path": "config.json", "content": "{\\"version\\": \\"1.0.0\\"}"}, "expectedOutcome": "config.json 文件被创建，包含 version 字段", "risk": "目录权限不足可能导致创建失败", "alternativeActions": ["SHELL_EXEC: 使用 echo 命令创建"]}

示例2 - 信息搜索任务：
任务: 搜索 Node.js 最新版本
输出: {"thought": "用户需要获取 Node.js 最新版本信息。使用 SHELL_EXEC 执行 curl 获取官方 API 数据。", "action": "SHELL_EXEC", "params": {"command": "curl -s https://nodejs.org/dist/index.json | head -20"}, "expectedOutcome": "获取到 Node.js 版本列表的 JSON 数据", "risk": "网络不可用或 API 变更", "alternativeActions": ["FETCH_URL: 直接访问官网"]}
`;
