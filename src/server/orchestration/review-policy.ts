import type { OrchestrationReviewPolicy } from '../../orchestration/orchestration-config.js';

let activeOrchestrationReviewPolicy: OrchestrationReviewPolicy = { enabled: false };

export function setActiveReviewPolicy(policy: OrchestrationReviewPolicy): void {
  activeOrchestrationReviewPolicy = policy;
}

export function getActiveReviewPolicy(): OrchestrationReviewPolicy {
  return activeOrchestrationReviewPolicy;
}
