import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SYSTEM_AGENT_CONFIG } from '../../../src/agents/finger-system-agent/index.js';
import { FINGER_SYSTEM_ALLOWED_TOOLS } from '../../../src/agents/finger-general/finger-general-module.js';

const ROOT = path.resolve(process.cwd());

const SYSTEM_PROMPT_PATH = path.join(ROOT, 'src/agents/finger-system-agent/system-prompt.md');
const SYSTEM_DEV_PATH = path.join(ROOT, 'src/agents/finger-system-agent/system-dev-prompt.md');
const CAPABILITY_PATH = path.join(ROOT, 'src/agents/finger-system-agent/capability.md');

describe('System Agent Static Config', () => {
  it('system prompt files exist', () => {
    expect(fs.existsSync(SYSTEM_PROMPT_PATH)).toBe(true);
    expect(fs.existsSync(SYSTEM_DEV_PATH)).toBe(true);
    expect(fs.existsSync(CAPABILITY_PATH)).toBe(true);
  });

  it('system prompt includes boundary rules', () => {
    const content = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
    expect(content).toContain('~/.finger/system');
    expect(content.toLowerCase()).toContain('delegate');
    expect(content).toContain('capability.md');
  });

  it('capability spec includes project handoff', () => {
    const content = fs.readFileSync(CAPABILITY_PATH, 'utf-8');
    expect(content).toContain('Project Handoff');
    expect(content).toContain('project_tool');
  });

  it('system agent tool whitelist includes project_tool', () => {
    expect(FINGER_SYSTEM_ALLOWED_TOOLS).toContain('project_tool');
  });

  it('system agent cwd/session path fixed', () => {
    expect(SYSTEM_AGENT_CONFIG.projectPath).toContain('.finger/system');
    expect(SYSTEM_AGENT_CONFIG.sessionPath).toContain('.finger/system/sessions');
  });
});
