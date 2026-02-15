import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';

/**
 * 能力描述接口 - 类似 SKILL.md frontmatter
 */
export interface CapabilityDescription {
  name: string;
  description: string;
  version?: string;
  metadata?: {
    author?: string;
    tags?: string[];
    minVersion?: string;
  };
  capabilities: {
    tools?: Array<{
      name: string;
      description: string;
      params?: Record<string, unknown>;
      handler?: string;
    }>;
    stateQueries?: Array<{
      name: string;
      description: string;
      command: string;
      parseScript?: string;
    }>;
    taskExecution?: {
      defaultModel?: string;
      systemPrompt?: string;
      maxTurns?: number;
      allowedTools?: string[];
      permissionMode?: 'auto' | 'manual' | 'selective';
    };
    resultFormat?: {
      type: 'json' | 'markdown' | 'text';
      template?: string;
      fields?: Array<{
        name: string;
        type: string;
        description: string;
      }>;
    };
  };
  resources?: {
    scripts?: string[];
    references?: string[];
    assets?: string[];
  };
}

/**
 * 解析能力描述文件
 */
export function parseCapabilityFile(filePath: string): CapabilityDescription {
  if (!existsSync(filePath)) {
    throw new Error(`Capability file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  return parseCapabilityContent(content, filePath);
}

/**
 * 解析能力描述内容（YAML frontmatter + Markdown body）
 */
export function parseCapabilityContent(content: string, sourcePath?: string): CapabilityDescription {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    throw new Error(`Invalid capability file format${sourcePath ? `: ${sourcePath}` : ''}. Expected YAML frontmatter.`);
  }

  const [, yamlContent, bodyContent] = frontmatterMatch;

  try {
    const parsed = parseYaml(yamlContent) as Partial<CapabilityDescription>;

    if (!parsed.name) {
      throw new Error('Capability must have a name');
    }
    if (!parsed.description) {
      throw new Error('Capability must have a description');
    }
    if (!parsed.capabilities) {
      parsed.capabilities = {};
    }

    if (bodyContent.trim()) {
      parsed.description = `${parsed.description}\n\n${bodyContent.trim()}`;
    }

    return parsed as CapabilityDescription;
  } catch (error) {
    throw new Error(
      `Failed to parse capability file${sourcePath ? `: ${sourcePath}` : ''}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * 验证能力描述
 */
export function validateCapability(cap: CapabilityDescription): string[] {
  const errors: string[] = [];

  if (!cap.name) {
    errors.push('Capability name is required');
  }
  if (!cap.description) {
    errors.push('Capability description is required');
  }

  if (cap.capabilities?.tools) {
    for (const tool of cap.capabilities.tools) {
      if (!tool.name) {
        errors.push('Tool must have a name');
      }
      if (!tool.description) {
        errors.push(`Tool ${tool.name || '(unnamed)'} must have a description`);
      }
    }
  }

  if (cap.capabilities?.stateQueries) {
    for (const query of cap.capabilities.stateQueries) {
      if (!query.name) {
        errors.push('State query must have a name');
      }
      if (!query.command) {
        errors.push(`State query ${query.name || '(unnamed)'} must have a command`);
      }
    }
  }

  return errors;
}

/**
 * 将能力描述应用到 Agent 配置
 */
export function applyCapabilityToConfig(
  cap: CapabilityDescription,
  baseConfig: Record<string, unknown>
): Record<string, unknown> {
  const config = { ...baseConfig };

  if (cap.capabilities.taskExecution) {
    const exec = cap.capabilities.taskExecution;
    if (exec.systemPrompt) config.systemPrompt = exec.systemPrompt;
    if (exec.defaultModel) config.defaultModel = exec.defaultModel;
    if (exec.maxTurns) config.maxTurns = exec.maxTurns;
    if (exec.permissionMode) config.permissionMode = exec.permissionMode;
  }

  if (cap.capabilities.tools) {
    config.allowedTools = cap.capabilities.tools.map(t => t.name);
  }

  return config;
}

/**
 * 示例能力描述模板
 */
export const capabilityTemplate = `---
name: my-agent-capability
description: |
  示例能力描述文件。
  使用 CLI 加载并赋予 agent 能力。
version: 1.0.0
metadata:
  author: your-name
  tags: [agent, executor, example]
capabilities:
  tools:
    - name: file.read
      description: 读取文件内容
      params:
        path:
          type: string
          required: true
    - name: file.write
      description: 写入文件内容
      params:
        path:
          type: string
          required: true
        content:
          type: string
          required: true
  stateQueries:
    - name: disk.usage
      description: 查询磁盘使用情况
      command: df -h
  taskExecution:
    defaultModel: iflow.kimi-k2.5
    systemPrompt: |
      你是一个专业执行者。
    maxTurns: 10
    permissionMode: auto
    allowedTools:
      - file.read
      - file.write
  resultFormat:
    type: json
    fields:
      - name: success
        type: boolean
        description: 任务是否成功
      - name: output
        type: string
        description: 任务输出内容
resources:
  scripts:
    - ./scripts/helper.sh
  references:
    - ./docs/api.md
---

# 使用说明

\`\`\`bash
finger agent run --capability ./my-capability.yaml --task "执行任务"
\`\`\`
`;
