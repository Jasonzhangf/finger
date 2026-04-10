import { resolve } from 'path';
import { FINGER_SOURCE_ROOT } from '../../core/source-root.js';
import { resolveHotPrompt, type HotPromptResolveResult } from '../base/prompt-template-loader.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';

export type ChatCodexDeveloperRole = 'system' | 'project';

const INLINE_TEMPLATE_FALLBACK: Record<ChatCodexDeveloperRole, string> = {
  system: 'role=system\nYou are the system agent. You dispatch tasks to project agents, review their deliverables, and decide whether to close or retry.',
  project: 'role=project\nExecute assigned tasks and return verifiable evidence.',
};

function envKeyByRole(role: ChatCodexDeveloperRole): string {
  return `FINGER_GENERAL_DEV_PROMPT_${role.toUpperCase()}_PATH`;
}

function resolveTemplateCandidates(role: ChatCodexDeveloperRole, explicitPath?: string): string[] {
  const fileName = `${role}.md`;
  const envKey = envKeyByRole(role);
  const envPath = process.env[envKey];
  const legacyEnvPath = process.env[`FINGER_CHAT_CODEX_DEV_PROMPT_${role.toUpperCase()}_PATH`];
  const candidates = [
    explicitPath,
    envPath,
    legacyEnvPath,
    resolve(FINGER_PATHS.config.promptsDir, 'finger-general', 'dev', fileName),
    resolve(FINGER_SOURCE_ROOT, 'prompts', 'finger-general', 'dev', fileName),
    resolve(FINGER_SOURCE_ROOT, 'src', 'agents', 'finger-general', 'dev-prompts', fileName),
    resolve(FINGER_PATHS.config.promptsDir, 'chat-codex', 'dev', fileName),
    resolve(FINGER_SOURCE_ROOT, 'prompts', 'chat-codex', 'dev', fileName),
    resolve(FINGER_SOURCE_ROOT, 'src', 'agents', 'chat-codex', 'dev-prompts', fileName),
    resolve(FINGER_PATHS.home, 'prompts', 'finger-general', 'dev', fileName),
    resolve(FINGER_PATHS.home, 'prompts', 'chat-codex', 'dev', fileName),
  ];

  const deduped: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || candidate.trim().length === 0) continue;
    if (!deduped.includes(candidate)) deduped.push(candidate);
  }
  return deduped;
}


export function resolveDeveloperPromptTemplateWithSource(
  role: ChatCodexDeveloperRole,
  explicitPath?: string,
): HotPromptResolveResult {
  return resolveHotPrompt({
    inlinePrompt: INLINE_TEMPLATE_FALLBACK[role],
    candidatePaths: resolveTemplateCandidates(role, explicitPath),
  });
}

export function resolveDeveloperPromptTemplate(
  role: ChatCodexDeveloperRole,
  explicitPath?: string,
): string {
  return resolveDeveloperPromptTemplateWithSource(role, explicitPath).prompt;
}
