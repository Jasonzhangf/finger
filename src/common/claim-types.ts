/**
 * Claim Types (V3)
 *
 * Shared types for completion claim workflow.
 * No runtime dependencies - pure type definitions.
 */

/**
 * V3 CompletionClaim Schema (from docs/design/project-task-lifecycle-state-machine.md)
 */
export interface CompletionClaim {
  taskId: string;
  summary: string;
  changedFiles: string[];
  verification: {
    commands: string[];
    outputs: string[];
    status: 'pass' | 'fail' | 'partial';
  };
  acceptanceChecklist: {
    criterion: string;
    status: 'met' | 'partial' | 'not_met';
    evidence?: string;
  }[];
  claimedAt: string;
  projectId?: string;
  sessionId?: string;
}

export type ClaimStatus = 'pending_review' | 'approved' | 'rejected';

export interface ReviewDecision {
  decision: 'PASS' | 'REJECT';
  reviewedAt: string;
  reviewerFeedback?: string;
}

export interface ClaimRecord {
  claimId: string;
  taskId: string;
  claim: CompletionClaim;
  status: ClaimStatus;
  reviewDecision?: ReviewDecision;
  createdAt: number;
  updatedAt: number;
}
