/**
 * Claim Registry (V3)
 *
 * Persist completion claims for System Agent review.
 * Replaces review-route-registry (V2) - no longer routes to independent reviewer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../core/finger-paths.js';
import type { CompletionClaim, ClaimStatus, ClaimRecord, ReviewDecision } from './claim-types.js';

const claims = new Map<string, ClaimRecord>();
const CLAIM_STORE_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'claim-registry.jsonl');

function ensureStoreDir(): void {
  const dir = path.dirname(CLAIM_STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function persistClaims(): void {
  ensureStoreDir();
  const lines = Array.from(claims.values()).map((record) => JSON.stringify(record));
  writeFileSync(CLAIM_STORE_PATH, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
}

function parseRecord(raw: string): ClaimRecord | null {
  try {
    const obj = JSON.parse(raw) as Partial<ClaimRecord>;
    if (!obj || typeof obj.claimId !== 'string' || obj.claimId.trim().length === 0) return null;
    if (!obj.claim || typeof obj.claim !== 'object') return null;
    if (!obj.claim.taskId || obj.claim.taskId.trim().length === 0) return null;
    return {
      claimId: obj.claimId.trim(),
      taskId: obj.claim.taskId.trim(),
      claim: obj.claim,
      status: obj.status ?? 'pending_review',
      reviewDecision: obj.reviewDecision,
      createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function loadClaimsFromDisk(): void {
  if (!existsSync(CLAIM_STORE_PATH)) return;
  const content = readFileSync(CLAIM_STORE_PATH, 'utf8');
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) continue;
    claims.set(record.claimId, record);
  }
}

loadClaimsFromDisk();

export function upsertClaimRecord(record: Omit<ClaimRecord, 'createdAt' | 'updatedAt'>): ClaimRecord {
  const prev = claims.get(record.claimId);
  const now = Date.now();
  const next: ClaimRecord = {
    ...record,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  claims.set(record.claimId, next);
  persistClaims();
  return next;
}

export function getClaimRecord(claimId: string): ClaimRecord | undefined {
  if (!claimId || claimId.trim().length === 0) return undefined;
  return claims.get(claimId.trim());
}

export function getClaimRecordByTaskId(taskId: string): ClaimRecord | undefined {
  if (!taskId || taskId.trim().length === 0) return undefined;
  for (const record of claims.values()) {
    if (record.taskId === taskId.trim() && record.status === 'pending_review') {
      return record;
    }
  }
  return undefined;
}

export function updateClaimStatus(
  claimId: string,
  status: ClaimStatus,
  reviewDecision?: ReviewDecision,
): ClaimRecord | undefined {
  const record = claims.get(claimId.trim());
  if (!record) return undefined;
  const updated: ClaimRecord = {
    ...record,
    status,
    reviewDecision,
    updatedAt: Date.now(),
  };
  claims.set(claimId, updated);
  persistClaims();
  return updated;
}

export function listPendingClaims(): ClaimRecord[] {
  return Array.from(claims.values()).filter(r => r.status === 'pending_review');
}

export function removeClaimRecord(claimId: string): boolean {
  if (!claimId || claimId.trim().length === 0) return false;
  const removed = claims.delete(claimId.trim());
  if (removed) persistClaims();
  return removed;
}

// Re-export types for convenience
export { type CompletionClaim, type ClaimStatus, type ClaimRecord, type ReviewDecision } from './claim-types.js';
