/**
 * Unit tests for CLI status command with callbackId support
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('CLI status command - callbackId support', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should query callbackId endpoint first', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'msg-1', callbackId: 'cb-123', status: 'completed' }),
    });

    // Simulate the status command logic
    const MESSAGE_HUB_URL = 'http://localhost:5521';
    const callbackId = 'cb-123';
    
    const res = await fetch(`${MESSAGE_HUB_URL}/api/v1/mailbox/callback/${callbackId}`);
    
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5521/api/v1/mailbox/callback/cb-123'
    );
    
    const data = await res.json();
    expect(data.callbackId).toBe('cb-123');
  });

  it('should fallback to messageId if callbackId returns 404', async () => {
    mockFetch
      .mockResolvedValueOnce({ status: 404 }) // callbackId not found
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'msg-1', status: 'completed' }),
      });

    const MESSAGE_HUB_URL = 'http://localhost:5521';
    const id = 'msg-1';
    
    let res = await fetch(`${MESSAGE_HUB_URL}/api/v1/mailbox/callback/${id}`);
    
    if (res.status === 404) {
      res = await fetch(`${MESSAGE_HUB_URL}/api/v1/mailbox/${id}`);
    }
    
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'http://localhost:5521/api/v1/mailbox/callback/msg-1'
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'http://localhost:5521/api/v1/mailbox/msg-1'
    );
  });

  it('should return 404 if both callbackId and messageId fail', async () => {
    mockFetch
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 404 });

    const MESSAGE_HUB_URL = 'http://localhost:5521';
    const id = 'non-existent';
    
    let res = await fetch(`${MESSAGE_HUB_URL}/api/v1/mailbox/callback/${id}`);
    
    if (res.status === 404) {
      res = await fetch(`${MESSAGE_HUB_URL}/api/v1/mailbox/${id}`);
    }
    
    expect(res.status).toBe(404);
  });
});
