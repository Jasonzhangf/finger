export type TaskReportResult = 'success' | 'failure';

export type TaskReportStatus =
  | 'in_progress'
  | 'review_ready'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'needs_rework';

export type TaskReportNextAction = 'continue' | 'review' | 'approve' | 'rework' | 'none';

export interface TaskReportContract {
  schema: 'finger.task-report.v1';
  taskId: string;
  taskName?: string;
  sessionId: string;
  projectId: string;
  sourceAgentId: string;
  result: TaskReportResult;
  status: TaskReportStatus;
  summary: string;
  deliveryArtifacts?: string;
  evidence?: string[];
  nextAction?: TaskReportNextAction;
  reviewDecision?: 'pass' | 'reject' | 'retry' | 'reviewing';
  deliveryClaim?: boolean;
  createdAt: string;
}

export interface BuildTaskReportInput {
  taskId: string;
  taskName?: string;
  sessionId: string;
  projectId: string;
  sourceAgentId: string;
  result: TaskReportResult;
  summary: string;
  status?: string;
  deliveryArtifacts?: string;
  evidence?: unknown;
  nextAction?: string;
  reviewDecision?: string;
  deliveryClaim?: boolean;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStatus(value: string, result: TaskReportResult): TaskReportStatus {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'in_progress'
    || normalized === 'in-progress'
    || normalized === 'progress'
    || normalized === 'working'
    || normalized === 'running'
  ) return 'in_progress';
  if (normalized === 'review_ready' || normalized === 'review-ready' || normalized === 'ready_for_review') {
    return 'review_ready';
  }
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'needs_rework' || normalized === 'rework' || normalized === 'retry') return 'needs_rework';
  if (normalized === 'completed' || normalized === 'done' || normalized === 'success') return 'completed';
  if (normalized === 'failed' || normalized === 'failure' || normalized === 'error') return 'failed';
  return result === 'failure' ? 'failed' : 'completed';
}

function normalizeNextAction(value: string): TaskReportNextAction | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'continue' || normalized === 'resume') return 'continue';
  if (normalized === 'review' || normalized === 'submit_review' || normalized === 'submit-for-review') return 'review';
  if (normalized === 'approve' || normalized === 'pending_approval') return 'approve';
  if (normalized === 'rework' || normalized === 'retry') return 'rework';
  if (normalized === 'none' || normalized === 'noop') return 'none';
  return undefined;
}

function normalizeReviewDecision(value: string): TaskReportContract['reviewDecision'] | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'approve' || normalized === 'approved') {
    return 'pass';
  }
  if (normalized === 'reject' || normalized === 'rejected' || normalized === 'fail' || normalized === 'failed') {
    return 'reject';
  }
  if (normalized === 'retry' || normalized === 'rework') return 'retry';
  if (normalized === 'reviewing') return 'reviewing';
  return undefined;
}

function normalizeEvidence(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => asTrimmedString(item))
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  const raw = asTrimmedString(value);
  if (!raw) return undefined;
  const items = raw
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function hasTaskReportShape(record: Record<string, unknown>): boolean {
  return typeof record.schema === 'string'
    && record.schema === 'finger.task-report.v1'
    && typeof record.taskId === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.projectId === 'string'
    && typeof record.sourceAgentId === 'string'
    && typeof record.result === 'string'
    && typeof record.summary === 'string';
}

export function parseTaskReportContract(raw: unknown): TaskReportContract | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!hasTaskReportShape(record)) return null;
  return buildTaskReportContract({
    taskId: asTrimmedString(record.taskId),
    taskName: asTrimmedString(record.taskName) || undefined,
    sessionId: asTrimmedString(record.sessionId),
    projectId: asTrimmedString(record.projectId),
    sourceAgentId: asTrimmedString(record.sourceAgentId),
    result: asTrimmedString(record.result) === 'failure' ? 'failure' : 'success',
    summary: asTrimmedString(record.summary),
    status: asTrimmedString(record.status),
    deliveryArtifacts: asTrimmedString(record.deliveryArtifacts) || undefined,
    evidence: record.evidence,
    nextAction: asTrimmedString(record.nextAction),
    reviewDecision: asTrimmedString(record.reviewDecision),
    deliveryClaim: typeof record.deliveryClaim === 'boolean' ? record.deliveryClaim : undefined,
  });
}

export function buildTaskReportContract(input: BuildTaskReportInput): TaskReportContract {
  const status = normalizeStatus(asTrimmedString(input.status), input.result);
  const normalizedTaskName = asTrimmedString(input.taskName);
  const normalizedDeliveryArtifacts = asTrimmedString(input.deliveryArtifacts);
  const normalizedEvidence = normalizeEvidence(input.evidence);
  const normalizedNextAction = normalizeNextAction(asTrimmedString(input.nextAction));
  const normalizedReviewDecision = normalizeReviewDecision(asTrimmedString(input.reviewDecision));
  return {
    schema: 'finger.task-report.v1',
    taskId: asTrimmedString(input.taskId),
    ...(normalizedTaskName ? { taskName: normalizedTaskName } : {}),
    sessionId: asTrimmedString(input.sessionId),
    projectId: asTrimmedString(input.projectId),
    sourceAgentId: asTrimmedString(input.sourceAgentId),
    result: input.result,
    status,
    summary: asTrimmedString(input.summary),
    ...(normalizedDeliveryArtifacts ? { deliveryArtifacts: normalizedDeliveryArtifacts } : {}),
    ...(normalizedEvidence ? { evidence: normalizedEvidence } : {}),
    ...(normalizedNextAction ? {
      nextAction: normalizedNextAction,
    } : {}),
    ...(normalizedReviewDecision ? {
      reviewDecision: normalizedReviewDecision,
    } : {}),
    ...(typeof input.deliveryClaim === 'boolean' ? { deliveryClaim: input.deliveryClaim } : {}),
    createdAt: new Date().toISOString(),
  };
}

export function resolveStructuredDeliveryClaim(report: TaskReportContract): boolean | undefined {
  if (typeof report.deliveryClaim === 'boolean') return report.deliveryClaim;
  if (report.status === 'in_progress' || report.status === 'blocked' || report.status === 'needs_rework') return false;
  if (report.status === 'review_ready' || report.status === 'completed') return true;
  if (report.nextAction === 'continue' || report.nextAction === 'rework') return false;
  if (report.nextAction === 'review' || report.nextAction === 'approve') return true;
  return undefined;
}
