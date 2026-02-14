export const buildFinalPrompt = (reasoning: string[], actions: string[]): string => `Based on the following reasoning and actions, provide a final result:
Reasoning:
${reasoning.join('\n')}
Actions:
${actions.join('\n')}`;

export const buildOrchestratorThinkPrompt = (
  task: string,
  context?: Record<string, unknown>
): string => `Task to orchestrate: ${task}
Context: ${JSON.stringify(context || {})}
Think about how to break this down into subtasks and assign them.`;

export const buildOrchestratorActPrompt = (thought: string): string => `Based on your thought: ${thought}
What specific actions should you take to orchestrate this task?
Consider creating subtasks, assigning to agents, or monitoring progress.`;

export const buildExecutorThinkPrompt = (
  task: string,
  context?: Record<string, unknown>
): string => `Execution task: ${task}
Context: ${JSON.stringify(context || {})}
Think about the implementation approach and potential issues.`;

export const buildExecutorActPrompt = (thought: string): string => `Based on your thought: ${thought}
What code or files should you create/modify?
Provide specific implementation steps.`;

export const buildReviewerThinkPrompt = (
  task: string,
  context?: Record<string, unknown>
): string => `Review task: ${task}
Context: ${JSON.stringify(context || {})}
Think about what aspects need review and potential issues.`;

export const buildReviewerActPrompt = (thought: string): string => `Based on your thought: ${thought}
What specific review actions should you take?
Identify issues, suggest improvements, or approve.`;

export const buildTesterThinkPrompt = (
  task: string,
  context?: Record<string, unknown>
): string => `Testing task: ${task}
Context: ${JSON.stringify(context || {})}
Think about test cases needed and testing strategy.`;

export const buildTesterActPrompt = (thought: string): string => `Based on your thought: ${thought}
What tests should you write or execute?
Provide specific test cases and expected results.`;

export const buildArchitectThinkPrompt = (
  task: string,
  context?: Record<string, unknown>
): string => `Architecture task: ${task}
Context: ${JSON.stringify(context || {})}
Think about design patterns, trade-offs, and system structure.`;

export const buildArchitectActPrompt = (thought: string): string => `Based on your thought: ${thought}
What architectural decisions and designs should you document?
Provide clear specifications and rationale.`;
