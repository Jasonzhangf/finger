import { describe, expect, it } from 'vitest';
import { deriveWsUrl, extractPanelReply } from '../../../src/cli/session-panel.js';

describe('session-panel helpers', () => {
  it('uses explicit ws url when provided', () => {
    expect(deriveWsUrl('http://localhost:5521', 'ws://localhost:18888')).toBe('ws://localhost:18888');
  });

  it('derives ws url from daemon url', () => {
    expect(deriveWsUrl('http://127.0.0.1:5521')).toBe('ws://127.0.0.1:5522');
    expect(deriveWsUrl('https://finger.local')).toBe('wss://finger.local:5522');
  });

  it('falls back to default ws url when daemon url is invalid', () => {
    expect(deriveWsUrl('not-a-url')).toBe('ws://localhost:5522');
  });

  it('extracts direct string reply', () => {
    expect(extractPanelReply('hello')).toBe('hello');
  });

  it('extracts response from flat object', () => {
    expect(extractPanelReply({ success: true, response: 'ok' })).toBe('ok');
  });

  it('extracts response from output wrapper', () => {
    expect(extractPanelReply({ output: { success: true, response: 'wrapped' } })).toBe('wrapped');
  });

  it('returns error text when error exists', () => {
    expect(extractPanelReply({ error: 'failed' })).toBe('Error: failed');
  });
});
