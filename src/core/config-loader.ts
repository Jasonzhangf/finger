/**
 * Finger Core Daemon - Config Loader
 * 
 * Loads inputs.yaml, outputs.yaml, routes.yaml
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS, ensureDir } from './finger-paths.js';
import type { InputsConfig, OutputsConfig, RoutesConfig } from './schema.js';

const CONFIG_DIR = FINGER_PATHS.config.dir;

function parseYamlSimple(content: string): unknown {
  // Very simple YAML parser for our use case
  // Supports: key: value, arrays with -, nested objects
  const lines = content.split('\n');
  const result: Record<string, unknown> = {};
  let currentKey = '';
  let currentObj: Record<string, unknown> | unknown[] = result;
  
  const stack: Array<{ obj: Record<string, unknown> | unknown[]; indent: number }> = [{ obj: result, indent: 0 }];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const currentIndent = line.search(/\S/);
    
    // Check if going back up
    while (stack.length > 1 && currentIndent <= stack[stack.length - 1].indent) {
      stack.pop();
      currentObj = stack[stack.length - 1].obj;
    }

    if (trimmed.startsWith('- ')) {
      // Array item
      const value = trimmed.slice(2);
      if (!Array.isArray(currentObj)) {
        // Convert to array
        const parent = stack[stack.length - 2]?.obj;
        if (parent && currentKey) {
          const arr: unknown[] = [];
          if (Array.isArray(parent)) {
            // This shouldn't happen for arrays
          } else {
            parent[currentKey] = arr;
            stack[stack.length - 1].obj = arr;
          }
          // Need to handle array items differently
          if (value.includes(':')) {
            const obj: Record<string, unknown> = {};
            const [k, v] = value.split(':').map(s => s.trim());
            if (v) obj[k] = parseValue(v);
            arr.push(obj);
          } else {
            arr.push(parseValue(value));
          }
          continue;
        }
      }
      if (Array.isArray(currentObj)) {
        if (value.includes(':')) {
          // Object in array
          const obj: Record<string, unknown> = {};
          const [k, v] = value.split(':').map(s => s.trim());
          if (v) obj[k] = parseValue(v);
          else {
            obj[k] = {};
            currentObj.push(obj);
            stack.push({ obj, indent: currentIndent });
            currentObj = obj;
            continue;
          }
          currentObj.push(obj);
        } else {
          currentObj.push(parseValue(value));
        }
      }
    } else if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      
      currentKey = key;
      
      if (value) {
        if (Array.isArray(currentObj)) {
          // This shouldn't happen for key-value on array
        } else {
          currentObj[key] = parseValue(value);
        }
      } else {
        if (Array.isArray(currentObj)) {
          // This shouldn't happen for key-value on array
        } else {
          currentObj[key] = {};
          stack.push({ obj: currentObj[key] as Record<string, unknown>, indent: currentIndent });
          currentObj = currentObj[key] as Record<string, unknown>;
        }
      }
    }
  }

  return result;
}

function parseValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

export function loadInputsConfig(): InputsConfig {
  const path = getPath('inputs.yaml');
  if (!fs.existsSync(path)) {
    return { version: 'v1', inputs: [] };
  }
  const content = fs.readFileSync(path, 'utf-8');
  const parsed = parseYamlSimple(content) as InputsConfig;
  return parsed;
}

export function loadOutputsConfig(): OutputsConfig {
  const path = getPath('outputs.yaml');
  if (!fs.existsSync(path)) {
    return { version: 'v1', outputs: [] };
  }
  const content = fs.readFileSync(path, 'utf-8');
  const parsed = parseYamlSimple(content) as OutputsConfig;
  return parsed;
}

export function loadRoutesConfig(): RoutesConfig {
  const path = getPath('routes.yaml');
  if (!fs.existsSync(path)) {
    return { version: 'v1', routes: [] };
  }
  const content = fs.readFileSync(path, 'utf-8');
  const parsed = parseYamlSimple(content) as RoutesConfig;
  return parsed;
}

function getPath(filename: string): string {
  return path.join(CONFIG_DIR, filename);
}

// Write helpers
export function writeInputsConfig(config: InputsConfig): void {
  ensureDir(CONFIG_DIR);
  const path = getPath('inputs.yaml');
  fs.writeFileSync(path, yamlStringify(config), 'utf-8');
}

export function writeOutputsConfig(config: OutputsConfig): void {
  ensureDir(CONFIG_DIR);
  const path = getPath('outputs.yaml');
  fs.writeFileSync(path, yamlStringify(config), 'utf-8');
}

export function writeRoutesConfig(config: RoutesConfig): void {
  ensureDir(CONFIG_DIR);
  const path = getPath('routes.yaml');
  fs.writeFileSync(path, yamlStringify(config), 'utf-8');
}

function yamlStringify(obj: unknown, indent = 0): string {
  const spaces = '  '.repeat(indent);
  
  if (obj === null) return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return obj.includes('\n') || obj.includes(':') ? `"${obj}"` : obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => {
      if (typeof item === 'object' && item !== null) {
        const inner = yamlStringify(item, indent + 1);
        return `${spaces}- ${inner.trimStart()}`;
      }
      return `${spaces}- ${yamlStringify(item)}`;
    }).join('\n');
  }
  
  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    return entries.map(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value) && value.length === 0) {
          return `${spaces}${key}: []`;
        }
        const inner = yamlStringify(value, indent + 1);
        return `${spaces}${key}:\n${inner}`;
      }
      return `${spaces}${key}: ${yamlStringify(value)}`;
    }).join('\n');
  }
  
  return String(obj);
}
