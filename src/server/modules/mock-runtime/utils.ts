import { isObjectRecord } from '../../common/object.js';
import { firstNonEmptyString } from '../../common/strings.js';
import type { MockOutcome, MockAgentRole } from './types.js';

export function parseMockOutcome(raw: string | undefined): MockOutcome {
  const normalized = (raw ?? '').trim().toLowerCase();
  return normalized === 'failure' || normalized === 'fail' || normalized === 'error'
    ? 'failure'
    : 'success';
}

export function pickMessageContext(
  message: unknown,
): {
  sessionId?: string;
  workflowId?: string;
  taskId?: string;
  content: string;
  assignment?: Record<string, unknown>;
} {
  const record = isObjectRecord(message) ? message : {};
  const metadata = isObjectRecord(record.metadata) ? record.metadata : {};
  const assignment = isObjectRecord(metadata.assignment) ? metadata.assignment : undefined;
  const sessionId = firstNonEmptyString(record.sessionId, record.session_id, metadata.sessionId, metadata.session_id);
  const workflowId = firstNonEmptyString(record.workflowId, record.workflow_id, metadata.workflowId, metadata.workflow_id);
  const taskId = firstNonEmptyString(
    record.taskId,
    record.task_id,
    metadata.taskId,
    metadata.task_id,
    assignment?.taskId,
    assignment?.task_id,
  );
  const content = firstNonEmptyString(record.description, record.text, record.content, taskId) ?? '[empty task]';
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(taskId ? { taskId } : {}),
    content,
    ...(assignment ? { assignment } : {}),
  };
}

export const DEFAULT_DEBUG_RUNTIME_MODULE_IDS: readonly string[] = ['executor-debug-agent', 'reviewer-debug-agent', 'searcher-debug-agent'];
