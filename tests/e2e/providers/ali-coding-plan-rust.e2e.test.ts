/**
 * Live E2E test for the Rust kernel bridge using the current ~/.finger kernel provider.
 *
 * This test intentionally validates the real bridge stdin/stdout contract instead of
 * assuming a hard-coded ali-coding-plan / anthropic-wire config that may no longer exist.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  buildKernelBridgeBinary,
  RUN_LIVE_MODEL_ROUND_E2E,
  startLiveKernelBridge,
  type LiveKernelBridge,
} from './kernel-bridge-live-helpers.js';

describe('Rust kernel bridge live provider smoke', () => {
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

  itLiveModelRound('responds to a simple math prompt with a model round', async () => {
    bridge = await startLiveKernelBridge(configPath);
    expect(bridge.provider.providerId).toBeTruthy();
    expect(bridge.provider.model).toBeTruthy();

    const startIndex = bridge.events.length;
    bridge.submit({
      id: 'math-turn',
      op: {
        type: 'user_turn',
        items: [{ type: 'text', text: '2+2，只回答数字。' }],
      },
    });

    const taskStarted = await bridge.waitForEvent(
      (event) => event.id === 'math-turn' && event.msg.type === 'task_started',
      30_000,
      startIndex,
    );
    expect(taskStarted.msg.type).toBe('task_started');

    const modelRound = await bridge.waitForEvent(
      (event) => event.id === 'math-turn' && event.msg.type === 'model_round',
      30_000,
      startIndex,
    );
    expect(modelRound.msg.type).toBe('model_round');
    expect(modelRound.msg.has_output_text).toBe(true);
    expect(modelRound.msg.response_status).toBe('completed');
  }, 65_000);

  itLiveModelRound('responds to a greeting with output text', async () => {
    bridge = await startLiveKernelBridge(configPath);

    const startIndex = bridge.events.length;
    bridge.submit({
      id: 'greeting-turn',
      op: {
        type: 'user_turn',
        items: [{ type: 'text', text: 'Hello' }],
      },
    });

    const modelRound = await bridge.waitForEvent(
      (event) => event.id === 'greeting-turn' && event.msg.type === 'model_round',
      30_000,
      startIndex,
    );

    expect(modelRound.msg.type).toBe('model_round');
    expect(modelRound.msg.has_output_text).toBe(true);
    expect(modelRound.msg.total_tokens).toBeGreaterThan(0);
  }, 65_000);
});
