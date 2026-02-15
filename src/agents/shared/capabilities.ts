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
  // 文件操作类
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
    id: 'file.write',
    name: '文件写入',
    description: '写入/编辑本地文件',
    category: 'file',
    sdk: ['iflow', 'codex', 'claude', 'native'],
    testable: true,
    implemented: true,
  },
  {
    id: 'file.list',
    name: '目录列出',
    description: '列出目录内容',
    category: 'file',
    sdk: ['iflow', 'codex', 'claude', 'native'],
    testable: true,
    implemented: true,
  },
  
  // Shell 命令类
  {
    id: 'shell.exec',
    name: 'Shell 执行',
    description: '执行 shell 命令',
    category: 'shell',
    sdk: ['iflow', 'codex', 'native'],
    testable: true,
    implemented: true,
  },
  
  // 网络类
  {
    id: 'web.search',
    name: '网络搜索',
    description: '搜索网络信息',
    category: 'network',
    sdk: ['iflow', 'codex', 'claude'],
    testable: false, // 需要 API key，不能直接测试
    implemented: false,
  },
  {
    id: 'web.fetch',
    name: '网页获取',
    description: '获取网页内容',
    category: 'network',
    sdk: ['iflow', 'codex', 'claude', 'native'],
    testable: true,
    implemented: true,
  },
  
  // AI 多媒体类
  {
    id: 'image.recognize',
    name: '图片识别',
    description: '识别图片内容',
    category: 'ai',
    sdk: ['iflow', 'codex', 'claude'],
    testable: false, // 需要多模态模型支持
    implemented: false,
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
  
  // BD 项目管理类
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
