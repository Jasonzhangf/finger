import { describe, it, expect } from 'vitest';
import { EventBusBlock } from '../../src/blocks/eventbus-block/index.js';

describe('EventBusBlock', () => {
  it('subscribes and publishes events', async () => {
    const block = new EventBusBlock('eventbus-test');
    let received: unknown = null;

    await block.execute('subscribe', {
      type: 'test-topic',
      handler: (event: { payload: unknown }) => {
        received = event.payload;
      }
    });

    await block.execute('emit', { type: 'test-topic', payload: { ok: true }, source: 'test' });
    expect(received).toEqual({ ok: true });
  });

  it('throws on unknown command', async () => {
    const block = new EventBusBlock('eventbus-test');
    await expect(block.execute('nope', {})).rejects.toThrow('Unknown command: nope');
  });
});
