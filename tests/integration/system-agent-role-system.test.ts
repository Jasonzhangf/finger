import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CHAT_CODEX_MODULE_PATH = join(process.cwd(), 'src/agents/chat-codex/chat-codex-module.ts');

describe('System Agent role=system Handling', () => {
  it('chat-codex-module handles role=system metadata', () => {
    const content = readFileSync(CHAT_CODEX_MODULE_PATH, 'utf-8');

    // System role detection should be centralized via isSystemControlTurn()
    expect(content).toContain('const isSystemRole = isSystemControlTurn(metadata)');
    expect(content).toContain('function isSystemControlTurn(');
  });

  it('role=system skips history to avoid contamination', () => {
    const content = readFileSync(CHAT_CODEX_MODULE_PATH, 'utf-8');

    expect(content).toContain('const historyItems = isSystemRole');
    expect(content).toContain('resolveHistoryItems(context?.history, metadata)');
  });

  it('role=system skips developer instructions', () => {
    const content = readFileSync(CHAT_CODEX_MODULE_PATH, 'utf-8');

    // System role keeps a dedicated prompt path (different from non-system roles)
    expect(content).toContain('developerInstructions');
    expect(content).toContain('if (isSystemRole) {');
  });

  it('system prompt files exist', () => {
    const systemPromptPath = join(process.cwd(), 'src/agents/finger-system-agent/system-prompt.md');
    const devPromptPath = join(process.cwd(), 'src/agents/finger-system-agent/system-dev-prompt.md');
    
    expect(existsSync(systemPromptPath)).toBe(true);
    expect(existsSync(devPromptPath)).toBe(true);
  });
});
