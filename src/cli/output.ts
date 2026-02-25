/**
 * CLI Output Formatter
 * 
 * Unified output formatting for human-readable and machine-readable output
 */

export type OutputFormat = 'text' | 'json' | 'stream';

let currentFormat: OutputFormat = 'text';

export function setOutputFormat(format: OutputFormat): void {
  currentFormat = format;
}

export function _getOutputFormat(): OutputFormat {
  return currentFormat;
}

/**
 * Format and print event
 */
export function printEvent(type: string, payload: unknown, timestamp?: string): void {
  const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
  
  if (currentFormat === 'json') {
    console.log(JSON.stringify({ type, payload, timestamp: timestamp || new Date().toISOString() }));
    return;
  }
  
  if (currentFormat === 'stream') {
    console.log(`event: ${type}`);
    console.log(`data: ${JSON.stringify(payload)}`);
    console.log('');
    return;
  }
  
  // Text format
  switch (type) {
    case 'phase_transition': {
      const phasePayload = payload as { from?: string; to?: string; trigger?: string };
      console.log(`[${time}] Phase: ${phasePayload.from} → ${phasePayload.to}`);
      break;
    }
    
    case 'task_started': {
      const taskPayload = payload as { taskId?: string; description?: string };
      console.log(`[${time}] Task ${taskPayload.taskId}: started - ${taskPayload.description || ''}`);
      break;
    }
    
    case 'task_completed': {
      const completedPayload = payload as { taskId?: string };
      console.log(`[${time}] Task ${completedPayload.taskId}: completed ✓`);
      break;
    }
    
    case 'task_failed': {
      const failedPayload = payload as { taskId?: string; error?: string };
      console.log(`[${time}] Task ${failedPayload.taskId}: failed ✗ - ${failedPayload.error || ''}`);
      break;
    }
    
    case 'agent_update': {
      const agentPayload = payload as { agentId?: string; status?: string; step?: { thought?: string; action?: string; observation?: string } };
      if (agentPayload.step?.thought) {
        console.log(`[${time}] [${agentPayload.agentId}] Thought: ${agentPayload.step.thought}`);
      }
      if (agentPayload.step?.action) {
        console.log(`[${time}] [${agentPayload.agentId}] Action: ${agentPayload.step.action}`);
      }
      if (agentPayload.step?.observation) {
        console.log(`[${time}] [${agentPayload.agentId}] Observation: ${agentPayload.step.observation}`);
      }
      break;
    }
    
    case 'workflow_update': {
      const workflowPayload = payload as { workflowId?: string; status?: string };
      console.log(`[${time}] Workflow ${workflowPayload.workflowId}: ${workflowPayload.status}`);
      break;
    }
      
    case 'user_decision_required': {
      const decisionPayload = payload as { message?: string; options?: string[] };
      console.log(`\n❓ ${decisionPayload.message}`);
      if (decisionPayload.options) {
        decisionPayload.options.forEach((opt, i) => {
          console.log(`  ${i + 1}. ${opt}`);
        });
      }
      break;
    }
      
    default:
      console.log(`[${time}] ${type}:`, payload);
  }
}

/**
 * Print workflow status
 */
export function printWorkflowStatus(status: {
  workflowId: string;
  fsmState: string;
  simplifiedStatus: string;
  tasks?: Array<{ id: string; status: string }>;
}): void {
  if (currentFormat === 'json') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  
  console.log(`Workflow: ${status.workflowId}`);
  console.log(`Status: ${status.simplifiedStatus} (${status.fsmState})`);
  
  if (status.tasks && status.tasks.length > 0) {
    console.log(`Tasks:`);
    status.tasks.forEach(task => {
      console.log(`  - ${task.id}: ${task.status}`);
    });
  }
}

/**
 * Print error
 */
export function printError(message: string, details?: unknown): void {
  if (currentFormat === 'json') {
    console.log(JSON.stringify({ error: message, details }));
    return;
  }
  
  console.error(`Error: ${message}`);
  if (details) {
    console.error('Details:', details);
  }
}

/**
 * Print success message
 */
export function printSuccess(message: string, data?: unknown): void {
  if (currentFormat === 'json') {
    console.log(JSON.stringify({ success: true, message, data }));
    return;
  }
  
  console.log(`✓ ${message}`);
  if (data) {
    console.log(data);
  }
}
