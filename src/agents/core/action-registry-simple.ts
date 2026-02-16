// 简化版 Action Registry - 统一接口

export interface ActionResult {
  success: boolean;
  observation: string;
  data?: unknown;
  error?: string;
  shouldStop?: boolean;
  stopReason?: 'complete' | 'fail' | 'escalate';
}

export interface ActionDefinition {
  name: string;
  description: string;
  paramsSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>, context: unknown) => Promise<ActionResult>;
  riskLevel?: 'low' | 'medium' | 'high';
}

export class ActionRegistry {
  private actions: Map<string, ActionDefinition> = new Map();

  register(action: ActionDefinition): void {
    this.actions.set(action.name, action);
  }

  get(name: string): unknown {
    return this.actions.get(name);
  }

  list(): Array<{ name: string; description: string; paramsSchema: Record<string, unknown> }> {
    return Array.from(this.actions.values());
  }

  async execute(name: string, params: Record<string, unknown>, _context: unknown): Promise<ActionResult> {
    const action = this.actions.get(name);
    if (!action) {
      return {
        success: false,
        observation: `Unknown action: ${name}`,
        error: `Action ${name} not found`,
      };
    }
    try {
      return await action.handler(params, _context);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        observation: `Execution error: ${errorMsg}`,
        error: errorMsg,
      };
    }
  }
}

// 创建执行者 Actions
export function createExecutorActions(cwd?: string): ActionDefinition[] {
  return [
    {
      name: 'WEB_SEARCH',
      description: '使用 DuckDuckGo 进行网络搜索',
      paramsSchema: {
        query: { type: 'string', required: true },
      },
      riskLevel: 'low',
      handler: async (params) => {
        const https = await import('https');
        const query = String(params.query || '').trim();

        if (!query) {
          return { success: false, observation: '搜索关键词为空', error: 'Empty query' };
        }

        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const html = await new Promise<string>((resolve, reject) => {
          const req = https.get(url, { timeout: 15000 }, (res) => {
              let data = '';
              res.on('data', (chunk) => {
                data += String(chunk);
              });
              res.on('end', () => resolve(data));
            });

          req.on('error', (err) => reject(err));
          req.on('timeout', () => {
            req.destroy(new Error('Request timeout'));
          });
        });

        const results: string[] = [];
        const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let match: RegExpExecArray | null = regex.exec(html);

        while (match && results.length < 5) {
          const href = match[1]
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"');
          const title = match[2]
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();

          if (title) {
            results.push(`- ${title} | ${href}`);
          }

          match = regex.exec(html);
        }

        if (results.length === 0) {
          return {
            success: true,
            observation: `搜索完成，但未提取到结构化结果: ${query}`,
            data: { query, results: [] as string[] },
          };
        }

        return {
          success: true,
          observation: `搜索结果 (${query}):\n${results.join('\n')}`,
          data: { query, results },
        };
      },
    },
    {
      name: 'FETCH_URL',
      description: '抓取网页内容',
      paramsSchema: {
        url: { type: 'string', required: true },
      },
      riskLevel: 'low',
      handler: async (params) => {
        const target = String(params.url || '').trim();
        if (!target) {
          return { success: false, observation: 'URL 不能为空', error: 'Empty url' };
        }

        const response = await fetch(target);
        const content = await response.text();
        return {
          success: true,
          observation: `网页获取成功: ${target} (status=${response.status}, length=${content.length})`,
          data: { url: target, status: response.status, content },
        };
      },
    },
    {
      name: 'READ_FILE',
      description: '读取文件内容',
      paramsSchema: {
        path: { type: 'string', required: true },
      },
      riskLevel: 'low',
      handler: async (params) => {
        const fs = await import('fs');
        const path = await import('path');
        // Accept legacy/alternate key names produced by LLMs.
        const rawPath =
          params.path ||
          params.filePath ||
          params.filename ||
          params.file ||
          params.absolute_path ||
          params.absolutePath;
        const inputPath = String(rawPath || '').trim();
        if (!inputPath) {
          return { success: false, observation: '文件路径不能为空', error: 'Empty path' };
        }

        const filePath = path.resolve(cwd || process.cwd(), inputPath);
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8');
          const preview = content.length > 500 ? `${content.slice(0, 500)}...` : content;
          return {
            success: true,
            observation: `文件读取成功: ${inputPath}\n${preview}`,
            data: { path: inputPath, content },
          };
        } catch (e) {
          return {
            success: false,
            observation: `文件读取失败: ${e}`,
            error: String(e),
          };
        }
      },
    },
    {
      name: 'WRITE_FILE',
      description: '创建或覆盖文件',
      paramsSchema: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      riskLevel: 'medium',
      handler: async (params) => {
        const fs = await import('fs');
        const path = await import('path');
        const rawPath =
          params.path ||
          params.filePath ||
          params.filename ||
          params.file ||
          params.absolute_path ||
          params.absolutePath ||
          params.saveTo;
        const inputPath = String(rawPath || '').trim();
        if (!inputPath) {
          return { success: false, observation: '文件路径不能为空', error: 'Empty path' };
        }
        const filePath = path.resolve(cwd || process.cwd(), inputPath);
        const rawContent = params.content ?? params.text ?? params.body;
        const content = String(rawContent || '');
        if (!content) {
          return { success: false, observation: '文件内容不能为空', error: 'Empty content' };
        }
        try {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.writeFile(filePath, content, 'utf-8');
          return { success: true, observation: `文件已创建: ${inputPath}` };
        } catch (e) {
          return { success: false, observation: `文件创建失败: ${e}`, error: String(e) };
        }
      },
    },
    {
      name: 'SHELL_EXEC',
      description: '执行 shell 命令',
      paramsSchema: { command: { type: 'string', required: true } },
      riskLevel: 'high',
      handler: async (params) => {
        const { exec } = await import('child_process');
        const maxObservationLength = 2000;
        const trimOutput = (value: string): string => {
          if (value.length <= maxObservationLength) return value;
          return `${value.slice(0, maxObservationLength)}\n...[output truncated]`;
        };
        return new Promise((resolve) => {
          exec(params.command as string, { cwd }, (error, stdout, stderr) => {
            if (error) {
              resolve({
                success: false,
                observation: trimOutput(stderr || error.message),
                error: error.message,
              });
            } else {
              resolve({ success: true, observation: trimOutput(stdout || '命令执行成功') });
            }
          });
        });
      },
    },
    {
      name: 'COMPLETE',
      description: '任务完成',
      paramsSchema: { output: { type: 'string', required: true } },
      handler: async (params) => ({
        success: true,
        observation: `任务完成: ${params.output}`,
        shouldStop: true,
        stopReason: 'complete',
      }),
    },
    {
      name: 'FAIL',
      description: '任务失败',
      paramsSchema: { reason: { type: 'string', required: true } },
      handler: async (params) => ({
        success: false,
        observation: `任务失败: ${params.reason}`,
        error: params.reason as string,
        shouldStop: true,
        stopReason: 'fail',
      }),
    },
  ];
}

// 创建编排者 Actions
export function createOrchestratorActions(): ActionDefinition[] {
  return [
    {
      name: 'PLAN',
      description: '拆解任务为子任务列表',
      paramsSchema: { tasks: { type: 'array', required: true } },
      handler: async (params) => ({
        success: true,
        observation: `已拆解 ${(params.tasks as unknown[]).length} 个子任务`,
      }),
    },
    {
      name: 'DISPATCH',
      description: '派发任务给执行者',
      paramsSchema: { taskId: { type: 'string', required: true } },
      handler: async (params) => ({
        success: true,
        observation: `任务 ${params.taskId} 已派发`,
      }),
    },
    {
      name: 'COMPLETE',
      description: '编排完成',
      paramsSchema: { summary: { type: 'string', required: true } },
      handler: async (params) => ({
        success: true,
        observation: `编排完成: ${params.summary}`,
        shouldStop: true,
        stopReason: 'complete',
      }),
    },
    {
      name: 'FAIL',
      description: '编排失败',
      paramsSchema: { reason: { type: 'string', required: true } },
      handler: async (params) => ({
        success: false,
        observation: `编排失败: ${params.reason}`,
        error: params.reason as string,
        shouldStop: true,
        stopReason: 'fail',
      }),
    },
  ];
}
