import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadAdapterWithHome(home: string) {
  vi.resetModules();
  process.env.FINGER_HOME = home;
  return import('../../../src/server/modules/update-stream-delivery-adapter');
}

describe('update-stream delivery adapter', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    delete process.env.FINGER_HOME;
    for (const dir of tmpDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dedups same route+signature inside dedup window', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'finger-update-delivery-'));
    tmpDirs.push(home);
    const { UpdateStreamDeliveryAdapter } = await loadAdapterWithHome(home);
    const adapter = new UpdateStreamDeliveryAdapter();
    let sendCount = 0;

    await adapter.enqueue({
      routeKey: 'qqbot::group::user',
      dedupSignature: 'status|same',
      send: async () => {
        sendCount += 1;
      },
    });
    await adapter.enqueue({
      routeKey: 'qqbot::group::user',
      dedupSignature: 'status|same',
      send: async () => {
        sendCount += 1;
      },
    });

    expect(sendCount).toBe(1);
  });

  it('retries with exponential backoff and eventually succeeds', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'finger-update-delivery-'));
    tmpDirs.push(home);
    await mkdir(path.join(home, 'config'), { recursive: true });
    await writeFile(path.join(home, 'config', 'update-stream.json'), JSON.stringify({
      enabled: true,
      delivery: {
        dedupWindowMs: 100,
        retry: {
          maxAttempts: 4,
          baseDelayMs: 1,
          maxDelayMs: 4,
          strategy: 'exponential',
        },
      },
    }, null, 2), 'utf-8');

    const { UpdateStreamDeliveryAdapter } = await loadAdapterWithHome(home);
    const adapter = new UpdateStreamDeliveryAdapter();
    let attempt = 0;
    await adapter.enqueue({
      routeKey: 'weixin::::user',
      dedupSignature: 'status|retry',
      send: async () => {
        attempt += 1;
        if (attempt < 3) throw new Error('temporary failed');
      },
    });
    expect(attempt).toBe(3);
  });

  it('keeps in-route ordering (second waits first)', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'finger-update-delivery-'));
    tmpDirs.push(home);
    const { UpdateStreamDeliveryAdapter } = await loadAdapterWithHome(home);
    const adapter = new UpdateStreamDeliveryAdapter();
    const order: string[] = [];

    const first = adapter.enqueue({
      routeKey: 'qqbot::group::user',
      dedupSignature: 'msg-1',
      send: async () => {
        order.push('first:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('first:end');
      },
    });
    const second = adapter.enqueue({
      routeKey: 'qqbot::group::user',
      dedupSignature: 'msg-2',
      send: async () => {
        order.push('second:start');
        order.push('second:end');
      },
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('applies channel throttleMs between same-route deliveries', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevVitest = process.env.VITEST;
    process.env.NODE_ENV = 'production';
    delete process.env.VITEST;
    const home = await mkdtemp(path.join(os.tmpdir(), 'finger-update-delivery-'));
    tmpDirs.push(home);
    await mkdir(path.join(home, 'config'), { recursive: true });
    await writeFile(path.join(home, 'config', 'update-stream.json'), JSON.stringify({
      enabled: true,
      channels: {
        qqbot: {
          enabled: true,
          throttleMs: 12,
        },
      },
    }, null, 2), 'utf-8');

    try {
      const { UpdateStreamDeliveryAdapter } = await loadAdapterWithHome(home);
      const adapter = new UpdateStreamDeliveryAdapter();
      const marks: number[] = [];
      const start = Date.now();

      await adapter.enqueue({
        routeKey: 'qqbot::group::user',
        dedupSignature: 'throttle-1',
        send: async () => {
          marks.push(Date.now());
        },
      });
      await adapter.enqueue({
        routeKey: 'qqbot::group::user',
        dedupSignature: 'throttle-2',
        send: async () => {
          marks.push(Date.now());
        },
      });

      expect(marks).toHaveLength(2);
      expect(marks[1] - marks[0]).toBeGreaterThanOrEqual(10);
      expect(Date.now() - start).toBeGreaterThanOrEqual(10);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (typeof prevVitest === 'undefined') delete process.env.VITEST;
      else process.env.VITEST = prevVitest;
    }
  });
});
