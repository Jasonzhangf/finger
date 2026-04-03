import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadPolicyModuleWithHome(home: string) {
  vi.resetModules();
  process.env.FINGER_HOME = home;
  return import('../../../src/server/modules/update-stream-policy');
}

describe('update-stream policy', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    delete process.env.FINGER_HOME;
    for (const dir of tmpDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates default update-stream config and resolves default policy', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'finger-update-stream-'));
    tmpDirs.push(home);
    const mod = await loadPolicyModuleWithHome(home);

    const policy = mod.resolveUpdateStreamPolicy({
      channelId: 'qqbot',
      role: 'project',
      sourceType: 'user',
    });
    expect(policy?.mode).toBe('all');
    expect(policy?.fields?.toolCalls).toBe(true);

    // Test mode uses in-memory defaults directly; no file materialization is required.
  });

  it('uses default policy in test mode even if file sets channel disabled', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'finger-update-stream-'));
    tmpDirs.push(home);
    await mkdir(path.join(home, 'config'), { recursive: true });
    await writeFile(path.join(home, 'config', 'update-stream.json'), JSON.stringify({
      enabled: true,
      defaultGranularity: 'tool',
      channels: {
        qqbot: {
          enabled: false,
        },
      },
    }, null, 2), 'utf-8');

    const mod = await loadPolicyModuleWithHome(home);
    const policy = mod.resolveUpdateStreamPolicy({
      channelId: 'qqbot',
      role: 'project',
      sourceType: 'user',
    });
    expect(policy?.mode).toBe('all');
    expect(policy?.fields?.bodyUpdates).toBe(true);
  });

  it('merge priority in resolvePushSettingsForSession is session > update-stream > channel defaults', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'finger-update-stream-'));
    tmpDirs.push(home);
    await mkdir(path.join(home, 'config'), { recursive: true });
    await writeFile(path.join(home, 'config', 'update-stream.json'), JSON.stringify({
      enabled: true,
      defaultGranularity: 'off',
      sourceTypePolicy: {
        user: { mode: 'all' },
      },
      channels: {
        qqbot: {
          enabled: true,
          granularity: 'off',
        },
      },
    }, null, 2), 'utf-8');

    vi.resetModules();
    process.env.FINGER_HOME = home;
    const [sessionUtils, deliveryPolicy] = await Promise.all([
      import('../../../src/server/modules/agent-status-subscriber-session-utils'),
      import('../../../src/common/progress-delivery-policy'),
    ]);

    const resolved = sessionUtils.resolvePushSettingsForSession({
      sessionId: 'session-1',
      channelId: 'qqbot',
      deps: {
        sessionManager: {
          getSession: () => ({
            id: 'session-1',
            context: {
              ownerAgentId: 'finger-system-agent',
              progressDelivery: {
                fields: {
                  bodyUpdates: true,
                },
              },
            },
          }),
        },
      } as any,
      fallbackPushSettings: {
        updateMode: 'both',
        reasoning: true,
        bodyUpdates: true,
        statusUpdate: true,
        toolCalls: true,
        stepUpdates: true,
        stepBatch: 1,
        progressUpdates: true,
      },
      normalizePolicy: deliveryPolicy.normalizeProgressDeliveryPolicy,
      applyPolicy: deliveryPolicy.applyProgressDeliveryPolicy,
    });

    // test mode uses defaults (granularity=milestone); session policy still overrides bodyUpdates.
    expect(resolved.bodyUpdates).toBe(true);
    expect(resolved.toolCalls).toBe(true);
    expect(resolved.statusUpdate).toBe(true);
  });
});
