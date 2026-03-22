/**
 * CLI Output Formatter
 * 
 * Unified output formatting for human-readable and machine-readable output
 */

import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('CliOutput');

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
  const time = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
  
  if (currentFormat === 'json') {
    clog.log(JSON.stringify({ type, payload, timestamp: timestamp || new Date().toISOString() }));
    return;
  }
  
  if (currentFormat === 'stream') {
    clog.log(`event: ${type}`);
    clog.log(`data: ${JSON.stringify(payload)}`);
    clog.log('');
    return;
  }
  
  // Text format
  switch (type) {
    case 'phase_transition': {
      const phasePayload = payload as { from?: string; to?: string; trigger?: string };
      clog.log(`[${time}] Phase: ${phasePayload.from} → ${phasePayload.to}`);
      break;
    }
    
    case 'task_started': {
      const taskPayload = payload as { taskId?: string; description?: string };
      clog.log(`[${time}] Task ${taskPayload.taskId}: started - ${taskPayload.description || ''}`);
      break;
    }
    
    case 'task_completed': {
      const completedPayload = payload as { taskId?: string };
      clog.log(`[${time}] Task ${completedPayload.taskId}: completed ✓`);
      break;
    }
    
    case 'task_failed': {
      const failedPayload = payload as { taskId?: string; error?: string };
      clog.log(`[${time}] Task ${failedPayload.taskId}: failed ✗ - ${failedPayload.error || ''}`);
      break;
    }
    
    case 'agent_update': {
      const agentPayload = payload as { agentId?: string; status?: string; step?: { thought?: string; action?: string; observation?: string } };
      if (agentPayload.step?.thought) {
        clog.log(`[${time}] [${agentPayload.agentId}] Thought: ${agentPayload.step.thought}`);
      }
      if (agentPayload.step?.action) {
        clog.log(`[${time}] [${agentPayload.agentId}] Action: ${agentPayload.step.action}`);
      }
      if (agentPayload.step?.observation) {
        clog.log(`[${time}] [${agentPayload.agentId}] Observation: ${agentPayload.step.observation}`);
      }
      break;
    }
    
    case 'workflow_update': {
      const workflowPayload = payload as { workflowId?: string; status?: string };
      clog.log(`[${time}] Workflow ${workflowPayload.workflowId}: ${workflowPayload.status}`);
      break;
    }
      
    case 'user_decision_required': {
      const decisionPayload = payload as { message?: string; options?: string[] };
      clog.log(`\n❓ ${decisionPayload.message}`);
      if (decisionPayload.options) {
        decisionPayload.options.forEach((opt, i) => {
          clog.log(`  ${i + 1}. ${opt}`);
        });
      }
      break;
    }
      
    default:
      clog.log(`[${time}] ${type}:`, payload);
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
    clog.log(JSON.stringify(status, null, 2));
    return;
  }
  
  clog.log(`Workflow: ${status.workflowId}`);
  clog.log(`Status: ${status.simplifiedStatus} (${status.fsmState})`);
  
  if (status.tasks && status.tasks.length > 0) {
    clog.log(`Tasks:`);
    status.tasks.forEach(task => {
      clog.log(`  - ${task.id}: ${task.status}`);
    });
  }
}

/**
 * Print error
 */
export function printError(message: string, details?: unknown): void {
  if (currentFormat === 'json') {
    clog.log(JSON.stringify({ error: message, details }));
    return;
  }
  
  clog.error(`Error: ${message}`);
  if (details) {
    clog.error('Details:', details);
  }
}

/**
 * Print success message
 */
export function printSuccess(message: string, data?: unknown): void {
  if (currentFormat === 'json') {
    clog.log(JSON.stringify({ success: true, message, data }));
    return;
  }
  
  clog.log(`✓ ${message}`);
  if (data) {
    clog.log(data);
  }
}
