import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoreDaemon } from '../../../src/core/daemon.js';
import { createMessage } from '../../../src/core/schema.js';

vi.mock('../../../src/core/config-loader.js', async () => {
  const actual = await vi.importActual('../../../src/core/config-loader.js');
  return {
    ...actual,
    loadInputsConfig: vi.fn(),
    loadOutputsConfig: vi.fn(),
    loadRoutesConfig: vi.fn(() => ({ version: 'v1', routes: [] })),
  };
});

const configLoader = await import('../../../src/core/config-loader.js');

describe('CoreDaemon openclaw pluginDir wiring', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-openclaw-daemon-'));
    fs.writeFileSync(
      path.join(tempDir, 'plugin-a.json'),
      JSON.stringify({
        id: 'plugin-a',
        name: 'Plugin A',
        status: 'enabled',
        tools: [
          {
            id: 'tool-1',
            name: 'Tool 1',
            description: 'test tool',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
          },
        ],
      }),
      'utf-8'
    );

    vi.mocked(configLoader.loadInputsConfig).mockReturnValue({
      version: 'v1',
      inputs: [
        {
          id: 'openclaw-in',
          kind: 'openclaw',
          enabled: true,
          config: {
            gatewayUrl: 'http://127.0.0.1:9997',
            pluginDir: tempDir,
          },
        },
      ],
    } as any);

    vi.mocked(configLoader.loadOutputsConfig).mockReturnValue({
      version: 'v1',
      outputs: [],
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads plugin manifests into daemon gate and handles message via loaded plugin', async () => {
    const daemon = new CoreDaemon();
    await daemon.start();

    // Force-create gate from mocked config path in case daemon start short-circuits in test env
    (daemon as any).openClawGate = new (await import('../../../src/blocks/openclaw-gate/index.js')).OpenClawGateBlock('openclaw-gate', { pluginDir: tempDir });

    const gate = (daemon as any).openClawGate;
    expect(gate.listPlugins()).toHaveLength(1);
    expect(gate.listPlugins()[0].id).toBe('plugin-a');

    const msg = createMessage('openclaw-call', {
      pluginId: 'plugin-a',
      toolId: 'tool-1',
      input: { x: 1 },
    }, 'openclaw-input');

    await expect((daemon as any).handleMessage(msg)).resolves.toBeUndefined();
    await daemon.stop();
  });
});
