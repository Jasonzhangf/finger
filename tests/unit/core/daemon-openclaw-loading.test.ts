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

function writePlugin(pluginRoot: string, params: { id: string; tools?: { id: string; name: string }[] }) {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'package.json'),
    JSON.stringify(
      {
        name: params.id,
        version: '1.0.0',
        type: 'module',
        openclaw: {
          id: params.id,
          extensions: ['./index.js'],
        },
      },
      null,
      2,
    ),
  );

  const toolsCode = params.tools?.map(t => 
    `api.registerTool({ id: '${t.id}', name: '${t.name}', description: '${t.name} tool', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } });`
  ).join('\n') || '';

  fs.writeFileSync(
    path.join(pluginRoot, 'index.js'),
    `export default {
      id: '${params.id}',
      register(api) {
        ${toolsCode}
      }
    };`,
    'utf-8',
  );
}

describe('CoreDaemon openclaw pluginDir wiring', () => {
  let tempDir: string;
  let openclawHome: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-openclaw-daemon-'));
    openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-openclaw-home-'));
    process.env.OPENCLAW_STATE_DIR = openclawHome;

    writePlugin(path.join(tempDir, 'plugin-a'), {
      id: 'plugin-a',
      tools: [{ id: 'tool-1', name: 'Tool 1' }],
    });

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
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it('loads plugin manifests into daemon gate and handles message via loaded plugin', async () => {
    const daemon = new CoreDaemon();
    await daemon.start();

    // Force-create gate from mocked config path in case daemon start short-circuits in test env
    (daemon as any).openClawGate = new (await import('../../../src/blocks/openclaw-gate/index.js')).OpenClawGateBlock('openclaw-gate', { pluginDir: tempDir });
    await (daemon as any).openClawGate.initialize();

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
