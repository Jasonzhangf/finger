/**
 * Skill Prompt Injector
 *
 * 在Agent启动时自动加载Skills并注入到系统提示词中
 */

import { getGlobalSkillsManager } from './skill-manager.js';
import { logger } from '../core/logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('SkillPromptInjector');

const log = logger.module('SkillPromptInjector');

const skillsManager = getGlobalSkillsManager();

function renderSkillsPrompt(skills: Array<{ name: string; description: string; path: string }>): string {
  if (skills.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Skills');
  lines.push('A skill is a set of local instructions stored in a `SKILL.md` file.');
  lines.push('### Available skills');
  for (const skill of skills) {
    const desc = skill.description?.trim().length > 0 ? skill.description.trim() : 'No description provided.';
    lines.push(`- ${skill.name}: ${desc} (file: ${skill.path}/SKILL.md)`);
  }
  lines.push('### How to use skills');
  lines.push('- If the task clearly matches a listed skill, prefer following that skill workflow.');
  lines.push('- Open the target `SKILL.md` and follow only the relevant sections; avoid bulk loading unrelated references.');
  lines.push('- Skills are workflows, not the canonical history store. If a skill depends on prior decisions that are not visible, retrieve them via `context_ledger.memory` instead of guessing.');
  lines.push('- The visible prompt history can be budgeted/partial; absence from prompt does not prove the event never happened.');
  lines.push('- When a skill cannot be applied (missing files/unclear instructions), state the issue and continue with best fallback.');
  return `\n\n${lines.join('\n')}`;
}

/**
 * 格式化Skills列表为提示词文本
 */
export async function formatSkillsAsPrompt(): Promise<string> {
  try {
    const skills = await skillsManager.listSkills();
    return renderSkillsPrompt(skills);
  } catch (error) {
    clog.error('[SkillPromptInjector] Failed to load skills:', error);
    return '';
  }
}

/**
 * 将Skills注入到系统提示词中
 * @param systemPrompt 原始系统提示词
 * @returns 包含Skills信息的系统提示词
 */
export async function injectSkillsIntoPrompt(systemPrompt: string): Promise<string> {
  const skillsSection = await formatSkillsAsPrompt();

  if (!skillsSection) {
    return systemPrompt;
  }

  // 将Skills部分追加到系统提示词的末尾
  return systemPrompt + skillsSection;
}

/**
 * Synchronously format Skills list as prompt text (using cached skills)
 */
export function formatSkillsAsPromptSync(): string {
  try {
    const skills = skillsManager.listSkillsSync();
    return renderSkillsPrompt(skills);
  } catch (error) {
    clog.error('[SkillPromptInjector] Failed to load skills sync:', error);
    return '';
  }
}

/**
 * Synchronously inject Skills into system prompt (using cached skills)
 * @param systemPrompt 原始系统提示词
 * @returns 包含Skills信息的系统提示词
 */
export function injectSkillsIntoPromptSync(systemPrompt: string): string {
  const skillsSection = formatSkillsAsPromptSync();

  if (!skillsSection) {
    return systemPrompt;
  }

  // 将Skills部分追加到系统提示词的末尾
  return systemPrompt + skillsSection;
}
