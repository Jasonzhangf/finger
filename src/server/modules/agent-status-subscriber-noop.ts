import type { UpdateStreamSourceType } from './update-stream-policy.js';

const NO_ACTIONABLE_PATTERNS: RegExp[] = [
  /\bno actionable work\b/i,
  /\bstale watchdog\b/i,
  /\bphantom(?:\/stale)? watchdog\b/i,
  /\balready complete\b/i,
  /\bno pending work\b/i,
  /\bno open work\b/i,
  /\bmailbox\s*empty\b/i,
  /\bmailbox\b.*\bclear(?:ed)?\b/i,
  /mailbox\s*清空/u,
  /\bmailbox\s*空\b/u,
  /\bmailbox\b.*无待办/u,
  /无待办[。,.，\s]/u,
  /无待办任务/u,
  /\bwatchdog\b.*误报/u,
  /误报.*\bwatchdog\b/u,
  /过期的监控触发器/u,
  /没有待处理的工作/u,
  /无待办工作/u,
  /没有待办工作/u,
  /无可执行/u,
];

const SCHEDULED_SOURCE_TYPES = new Set<UpdateStreamSourceType>([
  'heartbeat',
  'mailbox',
  'cron',
  'system-inject',
]);

const SYSTEM_RECOVERY_SOURCES = new Set<string>([
  'system-recovery',
  'system-project-recovery',
  
]);

export function isNoActionableWatchdogText(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const text = raw.trim();
  if (!text) return false;
  return NO_ACTIONABLE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isScheduledSourceType(sourceType: UpdateStreamSourceType): boolean {
  return SCHEDULED_SOURCE_TYPES.has(sourceType);
}

export function isSystemRecoverySourceAgent(sourceAgentId: string | undefined): boolean {
  if (typeof sourceAgentId !== 'string') return false;
  return SYSTEM_RECOVERY_SOURCES.has(sourceAgentId.trim());
}
