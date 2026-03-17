import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadChannelBridgeConfigs } from '../../../src/server/index.js';

describe('Channel Bridge Loading - enabledInDaemon', () => {
  let tempConfigDir: string;

  beforeEach(() => {
    // Create temporary config directory
    tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-test-'));
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempConfigDir)) {
      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('should skip loading when enabledInDaemon is false and log appropriate messages', async () => {
    // Create channels.json with enabledInDaemon: false
    const channelsConfig = {
      enabledInDaemon: false,
      channels: [
        {
          id: 'test-channel',
          channelId: 'test-channel',
          enabled: true,
          credentials: {
            appid: '123',
            token: 'test-token'
          }
        }
      ]
    };

    const channelsConfigPath = path.join(tempConfigDir, 'channels.json');
    fs.writeFileSync(channelsConfigPath, JSON.stringify(channelsConfig, null, 2));

    // Mock console.log to capture output
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Call the function with the temporary config directory
    await loadChannelBridgeConfigs(tempConfigDir);

    // Verify that the appropriate log messages were printed
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[Server] Channel bridge disabled in daemon (enabledInDaemon: false), skipping load'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[Server] Use "finger-gateway-bridge start" command to start channel bridge independently'
    );

    consoleLogSpy.mockRestore();
  });

  it('should proceed with loading when enabledInDaemon is true', async () => {
    // Create channels.json with enabledInDaemon: true
    const channelsConfig = {
      enabledInDaemon: true,
      channels: [
        {
          id: 'test-channel',
          channelId: 'test-channel',
          enabled: true,
          credentials: {
            appid: '123',
            token: 'test-token'
          }
        }
      ]
    };

    const channelsConfigPath = path.join(tempConfigDir, 'channels.json');
    fs.writeFileSync(channelsConfigPath, JSON.stringify(channelsConfig, null, 2));

    // Mock console.log to capture output
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Mock console.warn to capture warnings
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Call the function with the temporary config directory
    // Note: This will fail because channelBridgeManager.loadConfigs() will be called
    // and the global channelBridgeManager is not properly initialized in the test environment
    try {
      await loadChannelBridgeConfigs(tempConfigDir);
    } catch (err) {
      // Expected to fail because channelBridgeManager is not initialized
      // But we can still verify the log messages
    }

    // Verify that the "disabled" log message was NOT printed
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      '[Server] Channel bridge disabled in daemon (enabledInDaemon: false), skipping load'
    );

    // Verify that the "Found channels config file" log message was printed
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[Server] Found channels config file, channels:', 1
    );

    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('should proceed with loading when enabledInDaemon is not specified (default behavior)', async () => {
    // Create channels.json without enabledInDaemon field (defaults to true)
    const channelsConfig = {
      channels: [
        {
          id: 'test-channel',
          channelId: 'test-channel',
          enabled: true,
          credentials: {
            appid: '123',
            token: 'test-token'
          }
        }
      ]
    };

    const channelsConfigPath = path.join(tempConfigDir, 'channels.json');
    fs.writeFileSync(channelsConfigPath, JSON.stringify(channelsConfig, null, 2));

    // Mock console.log to capture output
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Call the function with the temporary config directory
    try {
      await loadChannelBridgeConfigs(tempConfigDir);
    } catch (err) {
      // Expected to fail because channelBridgeManager is not initialized
    }

    // Verify that the "disabled" log message was NOT printed
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      '[Server] Channel bridge disabled in daemon (enabledInDaemon: false), skipping load'
    );

    // Verify that the "Found channels config file" log message was printed
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[Server] Found channels config file, channels:', 1
    );

    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});
