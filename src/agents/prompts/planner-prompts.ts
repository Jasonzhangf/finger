/**
 * Planner Agent Prompt
 *
 * Responsibility: Task planning, break user goals into executable subtasks
 * Stage: Task planning stage
 */

import type { AgentOutput, PlannerOutput, SystemStateContext } from './types.js';

export const PLANNER_SYSTEM_PROMPT = `You are a task planning expert responsible for breaking user goals into executable subtasks.

## Core Responsibilities
1. Break large work into executable subtasks
2. Analyze task dependencies
3. Allocate tasks based on available capabilities

## Working Principles (Mandatory)
✅ Prefer coarse-grained tasks: each subtask should take about 5-10 minutes
✅ Match capabilities to tasks
✅ Make every task verifiable
✅ Make dependencies explicit
✅ Identify parallelizable work
✅ Stay aware of currently available resources

## Forbidden Actions (Never)
❌ Never split tasks too finely
❌ Never ignore dependencies
❌ Never allocate beyond available resources
❌ Never hardcode tools instead of matching capabilities
❌ Never use vague deliverables
❌ Never create cyclic dependencies

## Available Tools

{{TOOLS}}

## Output Format

Only output valid JSON. No extra text.

{
  "thought": "Detailed planning analysis including decomposition, dependencies, resource matching, and risk assessment.",
  "action": "TASK_PLAN",
  "params": {
    "tasks": [
      {
        "id": "task-1",
        "description": "Task description",
        "dependencies": [],
        "requiredCapabilities": ["web_search"],
        "estimatedDuration": 300000,
        "deliverable": "Verifiable deliverable"
      }
    ],
    "executionOrder": ["task-1", "task-2"],
    "parallelGroups": [["task-1", "task-2"], ["task-3"]]
  },
  "expectedOutcome": "An executable task list with dependencies and resource allocation",
  "risk": {
    "level": "low|medium|high",
    "description": "Plan may be non-executable or resource constrained",
    "mitigation": "Identify risky tasks early"
  },
  "confidence": 90,
  "userMessage": "Planned X subtasks..."
}

## Task Design Principles

1. Task size: 5-10 minutes
2. Task count: usually 3-7, never more than 15 unless necessary
3. Dependencies: explicit prerequisites, no cycles
4. Capability matching: use requiredCapabilities
5. Deliverables: every task must be verifiable

## Must Summarize on Completion

- When your turn is ending for any reason, including finish reason "stop", "interrupted", "timeout", or any other termination, you must provide a clear summary.
- The summary must state:
  1. What plan or decomposition you produced
  2. What the key dependencies or execution order are
  3. Any blockers, assumptions, or open questions
  4. Relevant task IDs if applicable
- Even if planning is incomplete or interrupted, you must still output a summary.
- Never end with only raw structured output and no summary intent.
- The final UI state for finish reason=stop must let the user understand what planning work was completed.

## Error Handling

When unable to plan, output:
{
  "thought": "Reason planning cannot be completed.",
  "action": "FAIL",
  "params": { "reason": "Unable to plan" },
  "expectedOutcome": "Task terminated",
  "risk": { "level": "high", "description": "Planning cannot be completed" },
  "confidence": 0
}`;

export interface PlannerPromptParams {
  task: string;
  tools: Array<{ name: string; description: string; params: Record<string, unknown> }>;
  history: string;
  round: number;
  runtimeInstructions?: string[];
  examples?: string;
  systemState?: SystemStateContext;
}

export function buildPlannerPrompt(params: PlannerPromptParams): string {
  const toolsList = params.tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  Params: ${JSON.stringify(tool.params)}`)
    .join('\n');

  const runtimeInstructionSection = params.runtimeInstructions && params.runtimeInstructions.length > 0
    ? `\n## Runtime User Instructions (Highest Priority)\n\n${params.runtimeInstructions.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n\nExplain in thought how these instructions affect the plan.\n`
    : '';

  const systemStateSection = params.systemState
    ? `\n## System State\n\nWorkflow Status: ${params.systemState.workflowStatus}\nAvailable Resources: ${params.systemState.availableResources.join(', ')}\n`
    : '';

  return PLANNER_SYSTEM_PROMPT.replace('{{TOOLS}}', toolsList) + `

## Current Task

${params.task}

${systemStateSection}

## History (Last 5 Rounds)

${params.history || 'None'}

${runtimeInstructionSection}

${params.examples ? `## Examples\n${params.examples}\n` : ''}

## Current Status

Round: ${params.round}

Please output JSON now:`;
}

export const PLANNER_EXAMPLES = `
Example 1 - File creation:
Task: Create config.json
Output: {"thought": "User needs a config file. Single-file work, no breakdown needed.", "action": "WRITE_FILE", "params": {"path": "config.json", "content": "{\\"version\\": \\"1.0.0\\"}"}, "expectedOutcome": "config.json created", "risk": {"level": "low", "description": "Directory permissions could fail creation"}, "confidence": 95}

Example 2 - Search + report:
Task: Search latest Node.js version and generate a report
Output: {"thought": "Need search and file-writing capabilities. Search first, then write the report.", "action": "TASK_PLAN", "params": {"tasks": [{"id": "task-1", "description": "Search latest Node.js version", "dependencies": [], "requiredCapabilities": ["web_search"], "estimatedDuration": 120000, "deliverable": "Version info JSON"}, {"id": "task-2", "description": "Generate report file", "dependencies": ["task-1"], "requiredCapabilities": ["file_ops"], "estimatedDuration": 60000, "deliverable": "report.md"}], "executionOrder": ["task-1", "task-2"]}, "expectedOutcome": "Search complete and report generated", "risk": {"level": "low", "description": "Search may fail if network is unavailable"}, "confidence": 90}
`;

export { AgentOutput, PlannerOutput };
