import { createHash } from 'node:crypto';
import { logger } from '../../core/logger.js';
import { resolveUpdateDeliveryConfig, resolveUpdateStreamChannelPolicy } from './update-stream-policy.js';

const log = logger.module('UpdateStreamDelivery');

interface DeliveryRequest {
  routeKey: string;
  dedupSignature: string;
  send: () => Promise<void>;
  meta?: Record<string, unknown>;
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

export class UpdateStreamDeliveryAdapter {
  private routeChains = new Map<string, Promise<void>>();
  private dedupCache = new Map<string, number>();
  private routeLastSentAt = new Map<string, number>();

  async enqueue(request: DeliveryRequest): Promise<void> {
    const cfg = resolveUpdateDeliveryConfig();
    const now = Date.now();
    this.cleanupDedup(now, cfg.dedupWindowMs);

    const dedupKey = `${request.routeKey}::${sha1(request.dedupSignature)}`;
    const prevTs = this.dedupCache.get(dedupKey);
    if (typeof prevTs === 'number' && now - prevTs <= cfg.dedupWindowMs) {
      log.debug('Skip duplicate delivery in dedup window', {
        routeKey: request.routeKey,
        dedupWindowMs: cfg.dedupWindowMs,
        ...(request.meta ?? {}),
      });
      return;
    }

    this.dedupCache.set(dedupKey, now);
    const prior = this.routeChains.get(request.routeKey) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(async () => {
        await this.applyRouteThrottle(request.routeKey);
        await this.sendWithRetry(request);
        this.routeLastSentAt.set(request.routeKey, Date.now());
      });
    this.routeChains.set(request.routeKey, next);
    try {
      await next;
    } finally {
      if (this.routeChains.get(request.routeKey) === next) {
        this.routeChains.delete(request.routeKey);
      }
    }
  }

  private async sendWithRetry(request: DeliveryRequest): Promise<void> {
    const cfg = resolveUpdateDeliveryConfig();
    const retryCfg = cfg.retry;
    let attempt = 0;
    let delay = retryCfg.baseDelayMs;
    let lastError: unknown;
    while (attempt < retryCfg.maxAttempts) {
      attempt += 1;
      try {
        await request.send();
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        log.warn('Delivery attempt failed', {
          attempt,
          maxAttempts: retryCfg.maxAttempts,
          routeKey: request.routeKey,
          error: message,
          ...(request.meta ?? {}),
        });
        if (attempt >= retryCfg.maxAttempts) break;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (retryCfg.strategy === 'exponential') {
          delay = Math.min(retryCfg.maxDelayMs, Math.max(delay, 1) * 2);
        } else {
          delay = Math.min(retryCfg.maxDelayMs, delay);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'delivery failed'));
  }

  private cleanupDedup(now: number, windowMs: number): void {
    if (this.dedupCache.size <= 2000) return;
    for (const [key, ts] of this.dedupCache.entries()) {
      if (now - ts > windowMs) this.dedupCache.delete(key);
    }
  }

  private async applyRouteThrottle(routeKey: string): Promise<void> {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    const channelId = routeKey.split('::')[0]?.trim();
    if (!channelId) return;
    const throttleMs = resolveUpdateStreamChannelPolicy(channelId)?.throttleMs;
    if (typeof throttleMs !== 'number' || throttleMs <= 0) return;
    const lastSentAt = this.routeLastSentAt.get(routeKey);
    if (typeof lastSentAt !== 'number') return;
    const elapsed = Date.now() - lastSentAt;
    const waitMs = throttleMs - elapsed;
    if (waitMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

const sharedAdapter = new UpdateStreamDeliveryAdapter();

export async function enqueueUpdateStreamDelivery(request: DeliveryRequest): Promise<void> {
  await sharedAdapter.enqueue(request);
}

export function enqueueUpdateStreamDeliveryNonBlocking(request: DeliveryRequest): void {
  void sharedAdapter.enqueue(request).catch((error) => {
    log.error('Non-blocking delivery failed', error instanceof Error ? error : new Error(String(error)));
  });
}
