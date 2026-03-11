import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../finger-paths.js';

export interface SystemCommandsConfig {
  enabled: boolean;
  channelWhitelist: string[];
  password?: {
    enabled: boolean;
    hash: string;
  };
}

const CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'system-commands.yaml');

export async function loadSystemCommandsConfig(): Promise<SystemCommandsConfig> {
  const defaultConfig: SystemCommandsConfig = {
    enabled: true,
    channelWhitelist: ['webui', 'cli'],
  };

  if (!fs.existsSync(CONFIG_PATH)) {
    return defaultConfig;
  }

  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    // Simple YAML parsing for our format
    return parseSimpleYaml(content, defaultConfig);
  } catch {
    return defaultConfig;
  }
}

export async function saveSystemCommandsConfig(config: SystemCommandsConfig): Promise<void> {
  const lines: string[] = [
    `enabled: ${config.enabled}`,
    `channelWhitelist:`,
    ...config.channelWhitelist.map(c => `  - ${c}`),
  ];
  
  if (config.password) {
    lines.push('password:');
    lines.push(`  enabled: ${config.password.enabled}`);
    lines.push(`  hash: ${config.password.hash}`);
  }
  
  fs.writeFileSync(CONFIG_PATH, lines.join('\n'), 'utf-8');
}

function parseSimpleYaml(content: string, defaults: SystemCommandsConfig): SystemCommandsConfig {
  const result = { ...defaults };
  const lines = content.split('\n');
  let inWhitelist = false;
  let inPassword = false;

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith('enabled:') && !inPassword) {
      result.enabled = trimmed.split(':')[1].trim() === 'true';
      inWhitelist = false;
    } else if (trimmed === 'channelWhitelist:') {
      inWhitelist = true;
      inPassword = false;
      result.channelWhitelist = [];
    } else if (trimmed.startsWith('- ') && inWhitelist) {
      result.channelWhitelist.push(trimmed.slice(2).trim());
    } else if (trimmed === 'password:') {
      inPassword = true;
      inWhitelist = false;
      result.password = { enabled: false, hash: '' };
    } else if (trimmed.startsWith('enabled:') && inPassword) {
      result.password!.enabled = trimmed.split(':')[1].trim() === 'true';
    } else if (trimmed.startsWith('hash:') && inPassword) {
      result.password!.hash = trimmed.split(':')[1].trim();
    } else if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-')) {
      inWhitelist = false;
      if (!trimmed.startsWith('password') && !trimmed.startsWith('  ')) {
        inPassword = false;
      }
    }
  }

  return result;
}
