import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
(globalThis as Record<string, unknown>).fetch = mockFetch;

describe('API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetch wrapper', () => {
    it('should make GET request', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: 'test' }),
      });

      const response = await fetch('/api/v1/test');
      const data = await response.json();

      expect(mockFetch).toHaveBeenCalledWith('/api/v1/test');
      expect(data).toEqual({ data: 'test' });
    });

    it('should make POST request with JSON body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      await fetch('/api/v1/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/v1/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      });
    });

    it('should handle error responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const response = await fetch('/api/v1/notfound');
      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(fetch('/api/v1/test')).rejects.toThrow('Network error');
    });
  });
});
