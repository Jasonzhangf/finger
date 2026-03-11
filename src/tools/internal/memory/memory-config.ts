/**
 * Memory Configuration
 *
 * 配置文件路径: ~/.finger/config/memory.yaml
 *
 * 默认配置:
 * - embedding: LM Studio 兼容的本地 endpoint
 * - vectorStore: Milvus Lite
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from '../../../core/finger-paths.js';

export interface MemoryConfig {
  embedding: {
    provider: 'local' | 'openai' | 'anthropic';
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  vectorStore: {
    type: 'milvus-lite';
    path?: string;
  };
  compact: {
    threshold: number;
    keepRecent: number;
  };
}

const DEFAULT_CONFIG: MemoryConfig = {
  embedding: {
    provider: 'local',
    baseUrl: 'http://localhost:1234/v1',
    model: 'text-embedding-nomic-embed-text-v1.5',
  },
  vectorStore: {
    type: 'milvus-lite',
    path: join(FINGER_PATHS.home, 'runtime', 'memory-vectors.db'),
  },
  compact: {
    threshold: 100,
    keepRecent: 50,
  },
};

let cachedConfig: MemoryConfig | null = null;

function getConfigPath(): string {
  return join(FINGER_PATHS.config.dir, 'memory.yaml');
}

function parseYamlSimple(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section header (no indent)
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const sectionMatch = trimmed.match(/^(\w+):\s*$/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        result[currentSection] = {};
        continue;
      }
    }

    // Key-value pair (indented)
    if (line.startsWith('  ') || line.startsWith('\t')) {
      const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (kvMatch && currentSection) {
        const [, key, value] = kvMatch;
        (result[currentSection] as Record<string, unknown>)[key] = parseValue(value);
      }
    }
  }

  return result;
}

function parseValue(value: string): unknown {
  // Strip inline comments
  const commentIndex = value.indexOf('#');
  if (commentIndex >= 0) {
    value = value.slice(0, commentIndex).trim();
  }

  if (!value) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

export function loadMemoryConfig(): MemoryConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    mkdirSync(FINGER_PATHS.config.dir, { recursive: true });
    writeFileSync(configPath, generateDefaultYaml(), 'utf-8');
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYamlSimple(content);
    cachedConfig = {
      embedding: { ...DEFAULT_CONFIG.embedding, ...(parsed.embedding as Record<string, unknown>) },
      vectorStore: { ...DEFAULT_CONFIG.vectorStore, ...(parsed.vectorStore as Record<string, unknown>) },
      compact: { ...DEFAULT_CONFIG.compact, ...(parsed.compact as Record<string, unknown>) },
    };
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }

  return cachedConfig;
}

function generateDefaultYaml(): string {
  return `# Memory Configuration
#
# Embedding settings for semantic search
embedding:
  provider: local  # local | openai | anthropic
  baseUrl: http://localhost:1234/v1  # LM Studio compatible endpoint
  model: text-embedding-nomic-embed-text-v1.5

# Vector store settings
vectorStore:
  type: milvus-lite
  path: ~/.finger/runtime/memory-vectors.db

# Compaction settings
compact:
  threshold: 100  # Auto-compact when entries exceed this
  keepRecent: 50  # Keep this many recent entries
`;
}

export function resetMemoryConfigCache(): void {
  cachedConfig = null;
}
