import type { UpdateStreamSourceType } from './update-stream-policy.js';

export function normalizeSourceTypeAlias(raw: unknown): UpdateStreamSourceType | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'user') return 'user';
  if (normalized === 'heartbeat' || normalized === 'system-heartbeat' || normalized.includes('heartbeat')) {
    return 'heartbeat';
  }
  if (normalized === 'mailbox' || normalized === 'mailbox-check' || normalized.includes('mailbox')) {
    return 'mailbox';
  }
  if (normalized === 'cron' || normalized === 'clock' || normalized.endsWith('-cron') || normalized.includes('schedule')) {
    return 'cron';
  }
  if (normalized === 'system-inject' || normalized === 'system_direct_inject' || normalized.includes('inject')) {
    return 'system-inject';
  }
  return undefined;
}
