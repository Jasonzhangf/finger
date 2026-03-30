/**
 * Review Route Registry
 *
 * Keeps runtime routing metadata so project delivery can be routed to reviewer
 * automatically without relying on orchestrator model decisions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';

export interface ReviewRouteRecord {
  taskId: string;
  taskName?: string;
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
const ROUTE_STORE_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'review-routes.jsonl');

function ensureStoreDir(): void {
  const dir = path.dirname(ROUTE_STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function persistRoutes(): void {
  ensureStoreDir();
  const lines = Array.from(routes.values()).map((record) => JSON.stringify(record));
  writeFileSync(ROUTE_STORE_PATH, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
}

function parseRecord(raw: string): ReviewRouteRecord | null {
  try {
    const obj = JSON.parse(raw) as Partial<ReviewRouteRecord>;
    if (!obj || typeof obj.taskId !== 'string' || obj.taskId.trim().length === 0) return null;
    if (typeof obj.reviewRequired !== 'boolean') return null;
    if (typeof obj.reviewAgentId !== 'string' || obj.reviewAgentId.trim().length === 0) return null;
    return {
      taskId: obj.taskId.trim(),
      taskName: typeof obj.taskName === 'string' ? obj.taskName.trim() || undefined : undefined,
      reviewRequired: obj.reviewRequired,
      reviewAgentId: obj.reviewAgentId.trim(),
      acceptanceCriteria: typeof obj.acceptanceCriteria === 'string' ? obj.acceptanceCriteria : undefined,
      projectId: typeof obj.projectId === 'string' ? obj.projectId : undefined,
      parentSessionId: typeof obj.parentSessionId === 'string' ? obj.parentSessionId : undefined,
      projectSessionId: typeof obj.projectSessionId === 'string' ? obj.projectSessionId : undefined,
      createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function loadRoutesFromDisk(): void {
  if (!existsSync(ROUTE_STORE_PATH)) return;
  const content = readFileSync(ROUTE_STORE_PATH, 'utf8');
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) continue;
    routes.set(record.taskId, record);
  }
}

loadRoutesFromDisk();

export function upsertReviewRoute(record: Omit<ReviewRouteRecord, 'createdAt' | 'updatedAt'>): ReviewRouteRecord {
  const prev = routes.get(record.taskId);
  const now = Date.now();
  const next: ReviewRouteRecord = {
    ...record,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  routes.set(record.taskId, next);
  persistRoutes();
  return next;
}

export function getReviewRoute(taskId: string): ReviewRouteRecord | undefined {
  if (!taskId || taskId.trim().length === 0) return undefined;
  return routes.get(taskId.trim());
}

function normalizeTaskNameKey(taskName: string): string {
  return taskName.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function getReviewRouteByTaskName(taskName: string): ReviewRouteRecord | undefined {
  if (!taskName || taskName.trim().length === 0) return undefined;
  const normalized = normalizeTaskNameKey(taskName);
  for (const record of routes.values()) {
    if (!record.taskName || record.taskName.trim().length === 0) continue;
    if (normalizeTaskNameKey(record.taskName) === normalized) return record;
  }
  return undefined;
}

export function removeReviewRoute(taskId: string): boolean {
  if (!taskId || taskId.trim().length === 0) return false;
  const removed = routes.delete(taskId.trim());
  if (removed) persistRoutes();
  return removed;
}

export function listReviewRoutes(): ReviewRouteRecord[] {
  return Array.from(routes.values())
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
