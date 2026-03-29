/**
 * Review Route Registry
 *
 * Keeps runtime routing metadata so project delivery can be routed to reviewer
 * automatically without relying on orchestrator model decisions.
 */

export interface ReviewRouteRecord {
  taskId: string;
  reviewRequired: boolean;
  reviewAgentId: string;
  acceptanceCriteria?: string;
  projectId?: string;
  parentSessionId?: string;
  projectSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

const routes = new Map<string, ReviewRouteRecord>();

export function upsertReviewRoute(record: Omit<ReviewRouteRecord, 'createdAt' | 'updatedAt'>): ReviewRouteRecord {
  const prev = routes.get(record.taskId);
  const now = Date.now();
  const next: ReviewRouteRecord = {
    ...record,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  routes.set(record.taskId, next);
  return next;
}

export function getReviewRoute(taskId: string): ReviewRouteRecord | undefined {
  if (!taskId || taskId.trim().length === 0) return undefined;
  return routes.get(taskId.trim());
}

export function removeReviewRoute(taskId: string): boolean {
  if (!taskId || taskId.trim().length === 0) return false;
  return routes.delete(taskId.trim());
}

