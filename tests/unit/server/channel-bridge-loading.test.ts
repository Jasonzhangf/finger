import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Channel Bridge Loading - enabledInDaemon', () => {
  let tempConfigDir: string;

  beforeEach(() => {
    tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempConfigDir)) {
      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    }
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unmock('../../../src/core/logger.js');
    vi.unmock('../../../src/bridges/index.js');
    vi.unmock('../../../src/bridges/channel-bridge-output.js');
    vi.unmock('../../../src/orchestration/shared-instances.js');
  });

  it('should skip loading when enabledInDaemon is false', async () => {
    const loggerSpies = createLoggerSpies();
    const bridgeManager = createBridgeManagerSpies();

    const loadChannelBridgeConfigs = await loadBootstrapModule({ loggerSpies, bridgeManager });

    const channelsConfig = {
      enabledInDaemon: false,
      channels: [{ id: 'test-channel', channelId: 'test-channel', enabled: true, credentials: { appid: '123', token: 'test-token' } }],
    };
    fs.writeFileSync(path.join(tempConfigDir, 'channels.json'), JSON.stringify(channelsConfig, null, 2));

    await loadChannelBridgeConfigs(tempConfigDir);

    expect(bridgeManager.addConfig).not.toHaveBeenCalled();
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'Channel bridge disabled in daemon (enabledInDaemon: false), skipping load',
    );
  });

  it('should proceed with loading when enabledInDaemon is true', async () => {
    const loggerSpies = createLoggerSpies();
    const bridgeManager = createBridgeManagerSpies();

    const loadChannelBridgeConfigs = await loadBootstrapModule({ loggerSpies, bridgeManager });

    const channelsConfig = {
      enabledInDaemon: true,
      channels: [{ id: 'test-channel', channelId: 'test-channel', enabled: true, credentials: { appid: '123', token: 'test-token' } }],
    };
    fs.writeFileSync(path.join(tempConfigDir, 'channels.json'), JSON.stringify(channelsConfig, null, 2));

    await loadChannelBridgeConfigs(tempConfigDir);

    expect(bridgeManager.addConfig).toHaveBeenCalledTimes(1);
    expect(bridgeManager.startBridge).toHaveBeenCalledWith('test-channel');
    expect(loggerSpies.warn).not.toHaveBeenCalledWith(
      'Failed to start bridge for channel (output still registered)',
      expect.anything(),
    );
  });

  it('should proceed with loading when enabledInDaemon is not specified (default behavior)', async () => {
    const loggerSpies = createLoggerSpies();
    const bridgeManager = createBridgeManagerSpies();

    const loadChannelBridgeConfigs = await loadBootstrapModule({ loggerSpies, bridgeManager });

    const channelsConfig = {
      channels: [{ id: 'test-channel', channelId: 'test-channel', enabled: true, credentials: { appid: '123', token: 'test-token' } }],
    };
    fs.writeFileSync(path.join(tempConfigDir, 'channels.json'), JSON.stringify(channelsConfig, null, 2));

    await loadChannelBridgeConfigs(tempConfigDir);

    expect(bridgeManager.addConfig).toHaveBeenCalledTimes(1);
    expect(bridgeManager.startBridge).toHaveBeenCalledWith('test-channel');
  });

  it('should skip webui bridge start without warning failure path', async () => {
    const loggerSpies = createLoggerSpies();
    const bridgeManager = createBridgeManagerSpies();

    const loadChannelBridgeConfigs = await loadBootstrapModule({ loggerSpies, bridgeManager });

    const channelsConfig = {
      enabledInDaemon: true,
      channels: [{ id: 'webui', channelId: 'webui', type: 'webui', enabled: true, credentials: {} }],
    };
    fs.writeFileSync(path.join(tempConfigDir, 'channels.json'), JSON.stringify(channelsConfig, null, 2));

    await loadChannelBridgeConfigs(tempConfigDir);

    expect(bridgeManager.addConfig).toHaveBeenCalledTimes(1);
    expect(bridgeManager.startBridge).not.toHaveBeenCalled();
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'Skip bridge start for webui channel; output-only delivery path is used',
      expect.objectContaining({ channelId: 'webui', type: 'webui' }),
    );
    expect(loggerSpies.warn).not.toHaveBeenCalledWith(
      'Failed to start bridge for channel (output still registered)',
      expect.anything(),
    );
  });
});

function createBridgeManagerSpies() {
  return {
    addConfig: vi.fn(),
    startBridge: vi.fn(async () => undefined),
  };
}

function createLoggerSpies() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function loadBootstrapModule(args: {
  loggerSpies: ReturnType<typeof createLoggerSpies>;
  bridgeManager: ReturnType<typeof createBridgeManagerSpies>;
}) {
  const { loggerSpies, bridgeManager } = args;
  vi.resetModules();
  vi.doMock('../../../src/core/logger.js', () => ({
    logger: {
      module: () => loggerSpies,
    },
  }));
  vi.doMock('../../../src/bridges/index.js', () => ({
    getChannelBridgeManager: () => bridgeManager,
  }));
  vi.doMock('../../../src/bridges/channel-bridge-output.js', () => ({
    createChannelBridgeOutput: () => ({
      register: vi.fn(),
      unregister: vi.fn(),
    }),
  }));
  vi.doMock('../../../src/orchestration/shared-instances.js', () => ({
    sharedMessageHub: {},
  }));

  const mod = await import('../../../src/server/modules/channel-bridge-bootstrap.js');
  return mod.loadChannelBridgeConfigs;
}
