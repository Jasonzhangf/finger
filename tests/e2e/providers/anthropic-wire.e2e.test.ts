/**
 * Live E2E test for the Rust kernel bridge protocol.
 *
 * The old version of this file assumed:
 * 1. a hard-coded Anthropic wire provider in ~/.finger/config/config.json
 * 2. an outdated stdin payload shape without `op`
 * 3. immediate `task_complete` delivery before graceful shutdown
 *
 * The current bridge contract is `Submission { id, op }`, and the active provider comes
 * from the user's real kernel config. These tests validate that real contract.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  buildKernelBridgeBinary,
  RUN_LIVE_MODEL_ROUND_E2E,
  startLiveKernelBridge,
  type LiveKernelBridge,
} from './kernel-bridge-live-helpers.js';

describe('Rust kernel bridge live protocol', () => {
  const configPath = join(process.env.HOME || '~', '.finger', 'config', 'config.json');
  const itLiveModelRound = RUN_LIVE_MODEL_ROUND_E2E ? it : it.skip;
  let bridge: LiveKernelBridge | null = null;

  beforeAll(() => {
    buildKernelBridgeBinary();
  }, 60_000);

  afterEach(async () => {
    if (bridge) {
      await bridge.shutdown();
      bridge = null;
    }
  });

  it('boots with the current configured kernel provider', async () => {
    bridge = await startLiveKernelBridge(configPath);

    expect(bridge.provider.providerId).toBeTruthy();
    expect(bridge.provider.wireApi).toBeTruthy();
    expect(bridge.provider.model).toBeTruthy();
    expect(bridge.events.some((event) => event.msg.type === 'session_configured')).toBe(true);
  });

  it('accepts Submission { id, op } payloads and emits task_started', async () => {
    bridge = await startLiveKernelBridge(configPath);

    const startIndex = bridge.events.length;
    bridge.submit({
      id: 'submit-shape-test',
      op: {
        type: 'user_turn',
        items: [{ type: 'text', text: 'Hello, what is your name?' }],
      },
    });

    const taskStarted = await bridge.waitForEvent(
      (event) => event.id === 'submit-shape-test' && event.msg.type === 'task_started',
      30_000,
      startIndex,
    );

    expect(taskStarted.msg.type).toBe('task_started');
  }, 30_000);

  itLiveModelRound('emits a completed model_round for a text submission', async () => {
    bridge = await startLiveKernelBridge(configPath);

    const startIndex = bridge.events.length;
    bridge.submit({
      id: 'model-round-test',
      op: {
        type: 'user_turn',
        items: [{ type: 'text', text: 'What is 2 + 2? 只回答数字。' }],
      },
    });

    const modelRound = await bridge.waitForEvent(
      (event) => event.id === 'model-round-test' && event.msg.type === 'model_round',
      60_000,
      startIndex,
    );

    expect(modelRound.msg.type).toBe('model_round');
    expect(modelRound.msg.has_output_text).toBe(true);
    expect(modelRound.msg.response_status).toBe('completed');
    expect(modelRound.msg.finish_reason).toBe('stop');
    expect(modelRound.msg.total_tokens).toBeGreaterThan(0);
  }, 70_000);
});
