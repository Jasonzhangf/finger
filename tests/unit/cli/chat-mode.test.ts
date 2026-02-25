import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock readline and WebSocket
vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    on: vi.fn(),
    prompt: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('ws', () => ({
  default: vi.fn(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  })),
}));

// Helper function to test response extraction logic
function extractReply(result: any): { reply: string; routeInfo: string } {
  let reply = '';
  let routeInfo = '';

  // Try new structure first: result.result.response
  if (result.result?.response) {
    reply = result.result.response;
    routeInfo = `[${result.result.isRouted ? 'Routed' : 'Direct'} → ${result.result.targetAgent || 'self'}]`;
  }
  // Fall back to old structure: result.result.result.response
  else if (result.result?.result?.response) {
    reply = result.result.result.response;
    routeInfo = `[${result.result.result.isRouted ? 'Routed' : 'Direct'} → ${result.result.result.targetAgent || 'self'}]`;
  }
  // Handle nested result object (fallback)
  else if (result.result?.result) {
    reply = JSON.stringify(result.result.result, null, 2);
    routeInfo = '[Raw result]';
  }
  // Handle simple result
  else if (result.result) {
    reply = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
    routeInfo = '[Simple result]';
  }
  // Handle empty response with error info
  else if (result.error) {
    reply = `Error: ${result.error}`;
    routeInfo = '[Error]';
  }
  // Unknown format - show error
  else {
    reply = 'Error: Empty response from daemon. Check daemon logs for details.';
    routeInfo = '[Error]';
  }

  return { reply, routeInfo };
}

describe('chat-mode response extraction', () => {
  it('should extract response from new structure (result.result.response)', () => {
    const result = {
      result: {
        response: 'Hello from new structure',
        isRouted: true,
        targetAgent: 'test-agent'
      }
    };
    const { reply, routeInfo } = extractReply(result);
    expect(reply).toBe('Hello from new structure');
    expect(routeInfo).toBe('[Routed → test-agent]');
  });

  it('should extract response from old structure (result.result.result.response)', () => {
    const result = {
      result: {
        result: {
          response: 'Hello from old structure',
          isRouted: false,
          targetAgent: 'self'
        }
      }
    };
    const { reply, routeInfo } = extractReply(result);
    expect(reply).toBe('Hello from old structure');
    expect(routeInfo).toBe('[Direct → self]');
  });

  it('should prefer new structure over old structure', () => {
    const result = {
      result: {
        response: 'New structure wins',
        isRouted: true,
        targetAgent: 'new-agent',
        result: {
          response: 'Old structure loses',
          isRouted: false,
          targetAgent: 'old-agent'
        }
      }
    };
    const { reply, routeInfo } = extractReply(result);
    expect(reply).toBe('New structure wins');
    expect(routeInfo).toBe('[Routed → new-agent]');
  });

  it('should handle empty response with error', () => {
    const result = {
      error: 'Daemon connection failed'
    };
    const { reply, routeInfo } = extractReply(result);
    expect(reply).toBe('Error: Daemon connection failed');
    expect(routeInfo).toBe('[Error]');
  });

  it('should handle completely empty response', () => {
    const result = {};
    const { reply, routeInfo } = extractReply(result);
    expect(reply).toBe('Error: Empty response from daemon. Check daemon logs for details.');
    expect(routeInfo).toBe('[Error]');
  });

  it('should handle simple string result', () => {
    const result = {
      result: 'Simple string response'
    };
    const { reply, routeInfo } = extractReply(result);
    expect(reply).toBe('Simple string response');
    expect(routeInfo).toBe('[Simple result]');
  });

  it('should handle nested result object', () => {
    const result = {
      result: {
        result: { data: 'nested' }
      }
    };
    const { reply, routeInfo } = extractReply(result);
    expect(reply).toBe(JSON.stringify({ data: 'nested' }, null, 2));
    expect(routeInfo).toBe('[Raw result]');
  });
});
