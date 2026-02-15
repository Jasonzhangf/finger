/**
 * 标准 Agent 能力列表
 * 基于 SDK 测试和实际功能定义
 */

export type CapabilityCategory = 
  | 'file'      // 文件操作
  | 'shell'     // 命令执行
  | 'network'   // 网络请求
  | 'ai'        // AI 相关 (图像/视频/生成)
  | 'bd'        // 项目管理
  | 'search'    // 搜索
  | 'execute'   // 执行
  | 'fetch'     // 获取
  | 'think'     // 思考
  | 'memory'    // 记忆/其他
  | 'other'     // 其他
  | 'system';   // 系统级

export interface Capability {
  id: string;
  name: string;
  description: string;
  category: CapabilityCategory;
  sdk: ('iflow' | 'codex' | 'claude' | 'native')[];
  testable: boolean;  // 是否可以通过 SDK 测试验证
  implemented: boolean; // 当前是否已实现
}

/**
 * 标准能力清单
 * 基于 iFlow/Codex/Claude SDK 实际支持的功能
 */
export const STANDARD_CAPABILITIES: Capability[] = [
  // === Read (只读) - 5 个工具 ===
  {
    id: 'file.read',
    name: '文件读取',
    description: '读取本地文件内容',
    category: 'file',
    sdk: ['iflow', 'codex', 'claude', 'native'],
    testable: true,
    implemented: true,
  },
  {
    id: 'image.read',
    name: '图片读取',
    description: '读取图片内容（需要支持视觉的模型如 kimi-k2.5）',
    category: 'ai',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  {
    id: 'file.read_many',
    name: '批量读取文件',
    description: '批量读取多个文件',
    category: 'file',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  {
    id: 'todo.read',
    name: '读取待办事项',
    description: '读取 todo 列表',
    category: 'memory',
    sdk: ['iflow'],
    testable: false,
    implemented: false,
  },
  
  // === Edit (编辑) - 6 个工具 ===
  {
    id: 'file.replace',
    name: '替换编辑',
    description: 'SmartEditTool 或 EditTool 编辑文件',
    category: 'file',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  {
    id: 'file.write',
    name: '文件写入',
    description: '写入/编辑本地文件',
    category: 'file',
    sdk: ['iflow', 'codex', 'claude', 'native'],
    testable: true,
    implemented: true,
  },
  {
    id: 'xml.escape',
    name: 'XML 转义',
    description: 'XML 内容转义处理',
    category: 'file',
    sdk: ['iflow'],
    testable: true,
    implemented: true,
  },
  {
    id: 'memory.save',
    name: '保存记忆',
    description: '保存记忆到上下文',
    category: 'memory',
    sdk: ['iflow', 'codex', 'claude'],
    testable: false,
    implemented: false,
  },
  {
    id: 'file.multi_edit',
    name: '多文件编辑',
    description: '同时编辑多个文件',
    category: 'file',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  
  // === Search (搜索) - 5 个工具 ===
  {
    id: 'file.list',
    name: '目录列出',
    description: '列出目录内容',
    category: 'file',
    sdk: ['iflow', 'codex', 'claude', 'native'],
    testable: true,
    implemented: true,
  },
  {
    id: 'file.search_content',
    name: '搜索文件内容',
    description: '在文件内容中搜索',
    category: 'search',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  {
    id: 'file.glob',
    name: '文件模式匹配',
    description: 'glob 模式匹配文件',
    category: 'file',
    sdk: ['iflow', 'codex', 'claude', 'native'],
    testable: true,
    implemented: true,
  },
  {
    id: 'web.search',
    name: '网络搜索',
    description: '搜索网络信息',
    category: 'network',
    sdk: ['iflow', 'codex', 'claude', 'native'],
    testable: true,
    implemented: true,
  },
  
  // === Execute (执行) - 3 个工具 ===
  {
    id: 'shell.exec',
    name: 'Shell 执行',
    description: '执行 shell 命令',
    category: 'execute',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  {
    id: 'task.run',
    name: '执行子任务',
    description: '运行子任务/子代理',
    category: 'execute',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: false,
  },
  {
    id: 'skill.exec',
    name: '执行技能',
    description: '执行预定义技能',
    category: 'execute',
    sdk: ['iflow', 'codex', 'claude'],
    testable: false,
    implemented: false,
  },
  
  // === Fetch (获取) - 1 个工具 ===
  {
    id: 'web.fetch',
    name: '网页获取',
    description: '获取网页内容',
    category: 'fetch',
    sdk: ['iflow', 'codex', 'claude', 'native'],
    testable: true,
    implemented: true,
  },
  
  // === Think (思考) - 1 个工具 ===
  {
    id: 'todo.write',
    name: '写入待办事项',
    description: '创建或更新 todo',
    category: 'think',
    sdk: ['iflow'],
    testable: false,
    implemented: false,
  },
  
  // === Other (其他) - 3 个工具 ===
  {
    id: 'shell.read_output',
    name: '读取命令输出',
    description: '读取 shell 命令输出',
    category: 'execute',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  {
    id: 'plan.exit',
    name: '退出规划模式',
    description: '退出 plan mode 并执行',
    category: 'execute',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  {
    id: 'user.ask',
    name: '询问用户问题',
    description: '向用户提问获取输入',
    category: 'other',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  
  // === BD 项目管理 (Native) ===
  {
    id: 'bd.query',
    name: 'BD 查询',
    description: '查询 bd 任务状态',
    category: 'bd',
    sdk: ['native'],
    testable: true,
    implemented: true,
  },
  {
    id: 'bd.update',
    name: 'BD 更新',
    description: '更新 bd 任务状态',
    category: 'bd',
    sdk: ['native'],
    testable: true,
    implemented: true,
  },
  
  // 系统级
  {
    id: 'system.info',
    name: '系统信息',
    description: '获取系统信息',
    category: 'system',
    sdk: ['native'],
    testable: true,
    implemented: true,
  },
  
  // === AI 多媒体 (需要特定模型支持) ===
  {
    id: 'image.recognize',
    name: '图片识别',
    description: '识别图片内容（需要 kimi-k2.5 等多模态模型）',
    category: 'ai',
    sdk: ['iflow', 'codex', 'claude'],
    testable: true,
    implemented: true,
  },
  {
    id: 'video.recognize',
    name: '视频识别',
    description: '分析视频内容',
    category: 'ai',
    sdk: ['iflow', 'codex', 'claude'],
    testable: false,
    implemented: false,
  },
  {
    id: 'image.generate',
    name: '图像生成',
    description: '根据描述生成图像',
    category: 'ai',
    sdk: ['iflow', 'codex', 'claude'],
    testable: false,
    implemented: false,
  },
];

/**
 * 按 SDK 筛选能力
 */
export function getCapabilitiesBySdk(sdk: 'iflow' | 'codex' | 'claude' | 'native'): Capability[] {
  return STANDARD_CAPABILITIES.filter(c => c.sdk.includes(sdk));
}

/**
 * 按类别筛选能力
 */
export function getCapabilitiesByCategory(category: CapabilityCategory): Capability[] {
  return STANDARD_CAPABILITIES.filter(c => c.category === category);
}

/**
 * 获取已测试验证的能力
 */
export function getTestedCapabilities(): Capability[] {
  return STANDARD_CAPABILITIES.filter(c => c.testable && c.implemented);
}

/**
 * 为 Agent 生成能力声明
 */
export function generateAgentCapabilityList(
  sdk: 'iflow' | 'codex' | 'claude' | 'native',
  role: string
): string[] {
  const baseCaps = getCapabilitiesBySdk(sdk);
  
  // 根据角色过滤
  switch (role) {
    case 'executor':
      return baseCaps
        .filter(c => ['file', 'shell', 'bd'].includes(c.category))
        .map(c => c.id);
    case 'orchestrator':
      return baseCaps
        .filter(c => c.category === 'bd')
        .map(c => c.id);
    case 'reviewer':
      return baseCaps
        .filter(c => c.category === 'file' || c.id === 'bd.query')
        .map(c => c.id);
    default:
      return baseCaps.map(c => c.id);
  }
}
