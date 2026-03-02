import { describe, it, expect } from 'vitest';
import { WebSocketBlock } from '../../src/blocks/websocket-block/index.js';

describe('WebSocketBlock', () => {
  it('starts and stops server', async () => {
    const block = new WebSocketBlock('ws-test');
    const started = await block.execute('start', { port: 0 });
    expect(started).toMatchObject({ started: true });
    expect(block.state.data?.running).toBe(true);

    const connections = await block.execute('connections', {});
    expect(connections).toEqual({ connections: 0 });

    const stopped = await block.execute('stop', {});
    expect(stopped).toEqual({ stopped: true });
    expect(block.state.data?.running).toBe(false);
  });

  it('broadcast returns sent count', async () => {
    const block = new WebSocketBlock('ws-test');
    await block.execute('start', { port: 0 });
    const result = await block.execute('broadcast', { message: 'ping' });
    expect(result).toEqual({ sent: 0 });
    await block.execute('stop', {});
  });
});
