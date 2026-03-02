import { describe, it, expect } from 'vitest';

const MODULES: Array<[string, () => Promise<Record<string, unknown>>]> = [
  ['agent-config-reloader', () => import('../../src/server/modules/agent-config-reloader.js')],
  ['agent-runtime', () => import('../../src/server/modules/agent-runtime.js')],
  ['block-registry-bootstrap', () => import('../../src/server/modules/block-registry-bootstrap.js')],
  ['event-forwarding-helpers', () => import('../../src/server/modules/event-forwarding-helpers.js')],
  ['event-forwarding', () => import('../../src/server/modules/event-forwarding.js')],
  ['finger-role-modules', () => import('../../src/server/modules/finger-role-modules.js')],
  ['message-session', () => import('../../src/server/modules/message-session.js')],
  ['mock-runtime-setup', () => import('../../src/server/modules/mock-runtime-setup.js')],
  ['mock-runtime', () => import('../../src/server/modules/mock-runtime.js')],
  ['module-registry-bootstrap', () => import('../../src/server/modules/module-registry-bootstrap.js')],
  ['orchestration-config-applier', () => import('../../src/server/modules/orchestration-config-applier.js')],
  ['port-guard', () => import('../../src/server/modules/port-guard.js')],
  ['server-constants', () => import('../../src/server/modules/server-constants.js')],
  ['server-flags', () => import('../../src/server/modules/server-flags.js')],
  ['session-logging', () => import('../../src/server/modules/session-logging.js')],
  ['session-workspaces', () => import('../../src/server/modules/session-workspaces.js')],
  ['websocket-server', () => import('../../src/server/modules/websocket-server.js')],
];

describe('Server Modules Uniqueness', () => {
  it('each module should export unique names', async () => {
    for (const [name, load] of MODULES) {
      const mod = await load();
      const exports = Object.keys(mod);
      const uniqueExports = new Set(exports);
      expect(exports.length, `${name} has duplicate export names`).toBe(uniqueExports.size);
      expect(exports.length, `${name} should export at least one symbol`).toBeGreaterThan(0);
    }
  });

  it('should not duplicate export names across modules', async () => {
    const seen = new Map<string, string>();
    const duplicates: Array<{ name: string; first: string; next: string }> = [];

    for (const [name, load] of MODULES) {
      const mod = await load();
      for (const exportName of Object.keys(mod)) {
        if (exportName === 'default') continue;
        const existing = seen.get(exportName);
        if (existing && existing !== name) {
          duplicates.push({ name: exportName, first: existing, next: name });
        } else {
          seen.set(exportName, name);
        }
      }
    }

    expect(duplicates).toEqual([]);
  });
});
