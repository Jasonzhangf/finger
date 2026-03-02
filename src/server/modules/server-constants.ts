import { FINGER_PATHS } from '../../core/finger-paths.js';
import { FINGER_ORCHESTRATOR_AGENT_ID, FINGER_GENERAL_AGENT_ID } from '../../agents/finger-general/finger-general-module.js';

export const ERROR_SAMPLE_DIR = FINGER_PATHS.logs.errorsamplesDir;

export const BLOCKING_MESSAGE_TIMEOUT_MS = Number.isFinite(Number(process.env.FINGER_BLOCKING_MESSAGE_TIMEOUT_MS))
  ? Math.max(1000, Math.floor(Number(process.env.FINGER_BLOCKING_MESSAGE_TIMEOUT_MS)))
  : 600_000;

export const BLOCKING_MESSAGE_MAX_RETRIES = Number.isFinite(Number(process.env.FINGER_BLOCKING_MESSAGE_MAX_RETRIES))
  ? Math.max(0, Math.floor(Number(process.env.FINGER_BLOCKING_MESSAGE_MAX_RETRIES)))
  : 5;

export const BLOCKING_MESSAGE_RETRY_BASE_MS = Number.isFinite(Number(process.env.FINGER_BLOCKING_MESSAGE_RETRY_BASE_MS))
  ? Math.max(100, Math.floor(Number(process.env.FINGER_BLOCKING_MESSAGE_RETRY_BASE_MS)))
  : 750;

export const PRIMARY_ORCHESTRATOR_AGENT_ID = FINGER_ORCHESTRATOR_AGENT_ID;
export const PRIMARY_ORCHESTRATOR_GATEWAY_ID = 'finger-orchestrator-gateway';
export const LEGACY_ORCHESTRATOR_AGENT_ID = 'chat-codex';
export const LEGACY_ORCHESTRATOR_GATEWAY_ID = 'chat-codex-gateway';
export const PRIMARY_ORCHESTRATOR_TARGET = (
  process.env.FINGER_PRIMARY_ORCHESTRATOR_TARGET
  || process.env.VITE_CHAT_PANEL_TARGET
  || PRIMARY_ORCHESTRATOR_GATEWAY_ID
).trim();
export const ALLOW_DIRECT_AGENT_ROUTE = process.env.FINGER_ALLOW_DIRECT_AGENT_ROUTE === '1';

export const LOCAL_IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

export function isPrimaryOrchestratorTarget(target: string): boolean {
  const normalized = target.trim();
  if (normalized.length === 0) return false;
  return normalized === PRIMARY_ORCHESTRATOR_TARGET
    || normalized === PRIMARY_ORCHESTRATOR_AGENT_ID
    || normalized === FINGER_GENERAL_AGENT_ID
    || normalized === LEGACY_ORCHESTRATOR_AGENT_ID
    || normalized === PRIMARY_ORCHESTRATOR_GATEWAY_ID
    || normalized === LEGACY_ORCHESTRATOR_GATEWAY_ID;
}
