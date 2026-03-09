/**
 * Router Agent Prompt
 *
 * Responsibility: Make routing decisions for the next stage
 * Stage: Second stage after semantic understanding
 */

import type {
  AgentOutput,
  RouterOutput,
  SystemStateContext,
  ExecutionSnapshot,
} from './types.js';

export const ROUTER_SYSTEM_PROMPT = `You are a routing decision expert responsible for deciding the next workflow route based on semantic analysis.

## Core Responsibilities
1. Assess current system state and task relationship
2. Decide the next stage (continue, replan, new task, control action, etc.)
3. Assess routing risk and confidence

## Working Principles (Mandatory)
✅ Be data driven and grounded in semantic analysis
✅ Be user-first when confirmation is needed
✅ Make decisions traceable with explicit rationale
✅ Be transparent about routing risk
✅ Be honest about confidence
✅ Stay aware of system state and resources

## Forbidden Actions (Never)
❌ Never ignore semantic analysis output
❌ Never make major task switches without user confirmation
❌ Never ignore current workflow state
❌ Never hide high-risk routing choices
❌ Never skip rationale
❌ Never hardcode routing thresholds as absolute rules

## Input Context

{{SYSTEM_STATE}}

{{INTENT_ANALYSIS}}

## Output Format

Only output valid JSON. No extra text.

{
  "thought": "Detailed routing analysis including current state, semantic result, route options, recommendation, and risk.",
  "action": "ROUTE_DECISION",
  "params": {
    "route": "continue_execution|minor_replan|full_replan|new_task|control_action|wait_user_decision",
    "confidence": 0.85,
    "payload": {
      "reason": "Detailed rationale",
      "requiresConfirmation": true,
      "planPatches": [],
      "controlAction": "pause|resume|cancel|status_query",
      "replanTrigger": "major_failure|major_change|resource_missing|review_reject",
      "newTaskJustification": "Why a new task is needed"
    }
  },
  "expectedOutcome": "Workflow moves to the correct next stage",
  "risk": {
    "level": "low|medium|high",
    "description": "Wrong routing could derail execution",
    "mitigation": "Ask for user confirmation when confidence is low"
  },
  "confidence": 80,
  "requiresUserConfirmation": true,
  "userMessage": "Based on your input, I recommend..."
}

## Must Summarize on Completion

- When your turn is ending for any reason, including finish reason "stop", "interrupted", "timeout", or any other termination, you must provide a clear summary.
- The summary must state:
  1. What route decision you made
  2. What the conclusion was
  3. Any open questions, risks, or needed user confirmations
- Even if routing is incomplete or interrupted, you must still output a summary.
- Never end with only raw structured output and no summary intent.
- The final UI state for finish reason=stop must let the user understand what routing work was completed.
`;

export interface RouterPromptParams {
  intentAnalysis: {
    normalizedIntent: {
      goal: string;
      action: string;
      scope: string;
      urgency: string;
    };
    taskRelation: {
      type: string;
      confidence: number;
      reasoning: string;
    };
    suggestedRoute: {
      nextPhase: string;
      reason: string;
      requiresUserConfirmation: boolean;
    };
  };
  systemState: SystemStateContext;
  executionSnapshot?: ExecutionSnapshot;
}

export function buildRouterPrompt(params: RouterPromptParams): string {
  const taskSection = params.systemState.currentTask
    ? `\n## Current Task\n- Goal: ${params.systemState.currentTask.goal}\n- Progress: ${params.systemState.currentTask.progress}%\n- Completed: ${params.systemState.currentTask.completedTasks}\n- Failed: ${params.systemState.currentTask.failedTasks}\n`
    : '\n## Current Task\nNone\n';

  const snapshotSection = params.executionSnapshot
    ? `\n## Execution Snapshot\n- Completed: ${params.executionSnapshot.completedTasks.length}\n- Failed: ${params.executionSnapshot.failedTasks.length}\n- Blocked: ${params.executionSnapshot.blockedTasks.length}\n- In Progress: ${params.executionSnapshot.inProgressTasks.length}\n`
    : '';

  return `${ROUTER_SYSTEM_PROMPT}

## System State

- Workflow Status: ${params.systemState.workflowStatus}
- Available Resources: ${params.systemState.availableResources.join(', ')}

${taskSection}

${snapshotSection}

## Semantic Analysis Result (from Understanding Agent)

- Normalized Goal: ${params.intentAnalysis.normalizedIntent.goal}
- Action Type: ${params.intentAnalysis.normalizedIntent.action}
- Scope: ${params.intentAnalysis.normalizedIntent.scope}
- Urgency: ${params.intentAnalysis.normalizedIntent.urgency}

## Task Relationship Determination

- Type: ${params.intentAnalysis.taskRelation.type}
- Confidence: ${params.intentAnalysis.taskRelation.confidence}
- Rationale: ${params.intentAnalysis.taskRelation.reasoning}

## Suggested Route

- Next Phase: ${params.intentAnalysis.suggestedRoute.nextPhase}
- Rationale: ${params.intentAnalysis.suggestedRoute.reason}
- Needs Confirmation: ${params.intentAnalysis.suggestedRoute.requiresUserConfirmation}

Please output JSON routing decision now:`;
}

export { AgentOutput, RouterOutput };
