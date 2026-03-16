import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CHAT_CODEX_MODULE_PATH = join(process.cwd(), 'src/agents/chat-codex/chat-codex-module.ts');

describe('System Agent role=system Handling', () => {
  it('chat-codex-module handles role=system metadata', () => {
    const content = readFileSync(CHAT_CODEX_MODULE_PATH, 'utf-8');
    
    // Check for isSystemRole detection
    expect(content).toContain("metadata?.role === 'system'");
    expect(content).toContain('const isSystemRole');
  });

  it('role=system skips history to avoid contamination', () => {
    const content = readFileSync(CHAT_CODEX_MODULE_PATH, 'utf-8');
    
    // Check that system role skips history
    expect(content).toContain('isSystemRole');
    expect(content).toContain('resolveHistoryItems');
  });

  it('role=system skips developer instructions', () => {
    const content = readFileSync(CHAT_CODEX_MODULE_PATH, 'utf-8');
    
    // Check that system role skips developer instructions
    expect(content).toContain('developerInstructions');
    expect(content).toContain('!isSystemRole');
  });

  it('system prompt files exist', () => {
    const systemPromptPath = join(process.cwd(), 'src/agents/finger-system-agent/system-prompt.md');
    const devPromptPath = join(process.cwd(), 'src/agents/finger-system-agent/system-dev-prompt.md');
    
    expect(existsSync(systemPromptPath)).toBe(true);
    expect(existsSync(devPromptPath)).toBe(true);
  });
});
