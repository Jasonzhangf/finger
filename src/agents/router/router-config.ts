/**
 * Router Config - 路由配置管理
 * 
 * 功能：
 * 1. 强制路由表 - 命中条件直接路由，不经过 LLM 分析
 * 2. 优选路由表 - 作为上下文发送给模型，影响决策
 * 3. 与消息分发层解耦，只在作为发送目标时命中
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../core/logger.js';

const log = logger.module('RouterConfig');

// ========== 配置类型定义 ==========

/**
 * 路由规则类型
 */
export enum RouteRuleType {
  /** 强制路由 - 命中条件直接路由 */
  FORCED = 'forced',
  /** 优选路由 - 作为上下文影响模型决策 */
  PREFERRED = 'preferred',
}

/**
 * 命中条件类型
 */
export enum MatchConditionType {
  /** 关键词匹配 */
  KEYWORD = 'keyword',
  /** 正则表达式匹配 */
  REGEX = 'regex',
  /** 前缀匹配 */
  PREFIX = 'prefix',
  /** 后缀匹配 */
  SUFFIX = 'suffix',
  /** 精确匹配 */
  EXACT = 'exact',
  /** 发送者匹配 */
  SENDER = 'sender',
  /** 消息类型匹配 */
  MESSAGE_TYPE = 'message_type',
}

/**
 * 命中条件
 */
export interface MatchCondition {
  type: MatchConditionType;
  value: string;
  caseSensitive?: boolean;
}

/**
 * 路由规则
 */
export interface RouteRule {
  /** 规则 ID */
  id: string;
  /** 规则名称 */
  name: string;
  /** 规则类型 */
  ruleType: RouteRuleType;
  /** 命中条件列表 (满足任一即命中) */
  conditions: MatchCondition[];
  /** 目标 Agent ID */
  targetAgentId: string;
  /** 目标 Agent 名称 */
  targetAgentName?: string;
  /** 优先级 (数字越大优先级越高) */
  priority: number;
  /** 描述 */
  description?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
  /** 命中次数统计 */
  hitCount?: number;
}

/**
 * 路由配置
 */
export interface RouterConfiguration {
  /** 配置版本 */
  version: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 强制路由表 */
  forcedRoutes: RouteRule[];
  /** 优选路由表 */
  preferredRoutes: RouteRule[];
  /** 默认目标 */
  defaultTarget: string;
  /** 配置说明 */
  description?: string;
}

// ========== 默认配置 ==========

const DEFAULT_CONFIG: RouterConfiguration = {
  version: '1.0.0',
  updatedAt: new Date().toISOString(),
  forcedRoutes: [
    // 示例：系统命令强制路由
    {
      id: 'forced-system-1',
      name: '系统命令',
      ruleType: RouteRuleType.FORCED,
      conditions: [
        { type: MatchConditionType.PREFIX, value: '/sys', caseSensitive: false },
        { type: MatchConditionType.PREFIX, value: '/daemon', caseSensitive: false },
      ],
      targetAgentId: 'system-agent',
      targetAgentName: 'System Agent',
      priority: 1000,
      description: '系统命令直接路由到 system-agent',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hitCount: 0,
    },
    // 示例：特定发送者强制路由
    {
      id: 'forced-sender-1',
      name: '管理员命令',
      ruleType: RouteRuleType.FORCED,
      conditions: [
        { type: MatchConditionType.SENDER, value: 'admin', caseSensitive: false },
      ],
      targetAgentId: 'task-orchestrator',
      targetAgentName: 'Task Orchestrator',
      priority: 900,
      description: '管理员命令优先路由到 task-orchestrator',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hitCount: 0,
    },
  ],
  preferredRoutes: [
    // 示例：代码相关优选
    {
      id: 'preferred-code-1',
      name: '代码创建',
      ruleType: RouteRuleType.PREFERRED,
      conditions: [
        { type: MatchConditionType.KEYWORD, value: '创建组件', caseSensitive: false },
        { type: MatchConditionType.KEYWORD, value: '写代码', caseSensitive: false },
        { type: MatchConditionType.KEYWORD, value: '生成代码', caseSensitive: false },
      ],
      targetAgentId: 'task-orchestrator',
      targetAgentName: 'Task Orchestrator',
      priority: 100,
      description: '代码创建相关优先路由到 task-orchestrator',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hitCount: 0,
    },
    // 示例：研究相关优选
    {
      id: 'preferred-research-1',
      name: '研究搜索',
      ruleType: RouteRuleType.PREFERRED,
      conditions: [
        { type: MatchConditionType.KEYWORD, value: '搜索', caseSensitive: false },
        { type: MatchConditionType.KEYWORD, value: '查找资料', caseSensitive: false },
        { type: MatchConditionType.KEYWORD, value: '调研', caseSensitive: false },
      ],
      targetAgentId: 'research-agent',
      targetAgentName: 'Research Agent',
      priority: 100,
      description: '研究搜索相关优先路由到 research-agent',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hitCount: 0,
    },
  ],
  defaultTarget: 'chat-agent',
  description: 'Router 路由配置 - 包含强制路由和优选路由',
};

// ========== 配置管理器 ==========

const CONFIG_PATH = join(homedir(), '.finger', 'router-config.json');

export class RouterConfigManager {
  private config: RouterConfiguration;

  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * 加载配置
   */
  private loadConfig(): RouterConfiguration {
    if (existsSync(CONFIG_PATH)) {
      try {
        const content = readFileSync(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(content) as RouterConfiguration;
        log.info('Loaded router config', { path: CONFIG_PATH });
        return config;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.error('Failed to load config, using default', err);
      }
    }

    // 创建默认配置
    this.saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  /**
   * 保存配置
   */
  private saveConfig(config: RouterConfiguration): void {
    const dir = join(homedir(), '.finger');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    config.updatedAt = new Date().toISOString();
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    log.info('Saved router config', { path: CONFIG_PATH });
  }

  /**
   * 获取完整配置
   */
  getConfig(): RouterConfiguration {
    return { ...this.config };
  }

  /**
   * 获取强制路由表
   */
  getForcedRoutes(): RouteRule[] {
    return this.config.forcedRoutes.filter(r => r.enabled);
  }

  /**
   * 获取优选路由表
   */
  getPreferredRoutes(): RouteRule[] {
    return this.config.preferredRoutes.filter(r => r.enabled);
  }

  /**
   * 获取默认目标
   */
  getDefaultTarget(): string {
    return this.config.defaultTarget;
  }

  /**
   * 检查是否命中强制路由
   */
  matchForcedRoute(text: string, senderId?: string, messageType?: string): RouteRule | null {
    const routes = this.getForcedRoutes();
    
    // 按优先级排序
    routes.sort((a, b) => b.priority - a.priority);

    for (const route of routes) {
      if (this.matchConditions(route.conditions, text, senderId, messageType)) {
        // 更新命中次数
        route.hitCount = (route.hitCount || 0) + 1;
        this.saveConfig(this.config);
        
        log.info('Matched forced route', { 
          routeId: route.id, 
          routeName: route.name,
          target: route.targetAgentId 
        });
        
        return route;
      }
    }

    return null;
  }

  /**
   * 检查是否命中优选路由 (返回所有命中的规则)
   */
  matchPreferredRoutes(text: string, senderId?: string, messageType?: string): RouteRule[] {
    const routes = this.getPreferredRoutes();
    const matched: RouteRule[] = [];

    for (const route of routes) {
      if (this.matchConditions(route.conditions, text, senderId, messageType)) {
        // 更新命中次数
        route.hitCount = (route.hitCount || 0) + 1;
        matched.push(route);
      }
    }

    // 按优先级排序
    matched.sort((a, b) => b.priority - a.priority);

    if (matched.length > 0) {
      log.info('Matched preferred routes', { 
        count: matched.length,
        routes: matched.map(r => r.id) 
      });
    }

    return matched;
  }

  /**
   * 检查条件是否命中
   */
  private matchConditions(
    conditions: MatchCondition[], 
    text: string, 
    senderId?: string, 
    messageType?: string
  ): boolean {
    // 满足任一条件即命中
    return conditions.some(condition => {
      switch (condition.type) {
        case MatchConditionType.KEYWORD:
          return this.matchKeyword(text, condition.value, condition.caseSensitive);
        
        case MatchConditionType.REGEX:
          return this.matchRegex(text, condition.value);
        
        case MatchConditionType.PREFIX:
          return this.matchPrefix(text, condition.value, condition.caseSensitive);
        
        case MatchConditionType.SUFFIX:
          return this.matchSuffix(text, condition.value, condition.caseSensitive);
        
        case MatchConditionType.EXACT:
          return this.matchExact(text, condition.value, condition.caseSensitive);
        
        case MatchConditionType.SENDER:
          return senderId ? this.matchKeyword(senderId, condition.value, condition.caseSensitive) : false;
        
        case MatchConditionType.MESSAGE_TYPE:
          return messageType ? this.matchExact(messageType, condition.value, condition.caseSensitive) : false;
        
        default:
          return false;
      }
    });
  }

  /**
   * 关键词匹配
   */
  private matchKeyword(text: string, keyword: string, caseSensitive?: boolean): boolean {
    const source = caseSensitive ? text : text.toLowerCase();
    const target = caseSensitive ? keyword : keyword.toLowerCase();
    return source.includes(target);
  }

  /**
   * 正则匹配
   */
  private matchRegex(text: string, pattern: string): boolean {
    try {
      const regex = new RegExp(pattern);
      return regex.test(text);
    } catch {
      return false;
    }
  }

  /**
   * 前缀匹配
   */
  private matchPrefix(text: string, prefix: string, caseSensitive?: boolean): boolean {
    const source = caseSensitive ? text : text.toLowerCase();
    const target = caseSensitive ? prefix : prefix.toLowerCase();
    return source.startsWith(target);
  }

  /**
   * 后缀匹配
   */
  private matchSuffix(text: string, suffix: string, caseSensitive?: boolean): boolean {
    const source = caseSensitive ? text : text.toLowerCase();
    const target = caseSensitive ? suffix : suffix.toLowerCase();
    return source.endsWith(target);
  }

  /**
   * 精确匹配
   */
  private matchExact(text: string, value: string, caseSensitive?: boolean): boolean {
    const source = caseSensitive ? text : text.toLowerCase();
    const target = caseSensitive ? value : value.toLowerCase();
    return source === target;
  }

  /**
   * 添加路由规则
   */
  addRoute(rule: RouteRule): void {
    if (rule.ruleType === RouteRuleType.FORCED) {
      this.config.forcedRoutes.push(rule);
    } else {
      this.config.preferredRoutes.push(rule);
    }
    this.saveConfig(this.config);
    log.info('Added route rule', { ruleId: rule.id, ruleType: rule.ruleType });
  }

  /**
   * 删除路由规则
   */
  removeRoute(ruleId: string): boolean {
    const forcedIndex = this.config.forcedRoutes.findIndex(r => r.id === ruleId);
    if (forcedIndex >= 0) {
      this.config.forcedRoutes.splice(forcedIndex, 1);
      this.saveConfig(this.config);
      return true;
    }

    const preferredIndex = this.config.preferredRoutes.findIndex(r => r.id === ruleId);
    if (preferredIndex >= 0) {
      this.config.preferredRoutes.splice(preferredIndex, 1);
      this.saveConfig(this.config);
      return true;
    }

    return false;
  }

  /**
   * 更新路由规则
   */
  updateRoute(ruleId: string, updates: Partial<RouteRule>): boolean {
    const route = this.config.forcedRoutes.find(r => r.id === ruleId) ||
                  this.config.preferredRoutes.find(r => r.id === ruleId);
    
    if (!route) {
      return false;
    }

    Object.assign(route, updates, { updatedAt: new Date().toISOString() });
    this.saveConfig(this.config);
    return true;
  }

  /**
   * 导出配置为 JSON
   */
  exportConfig(): string {
    return JSON.stringify(this.config, null, 2);
  }

  /**
   * 从 JSON 导入配置
   */
  importConfig(json: string): boolean {
    try {
      const config = JSON.parse(json) as RouterConfiguration;
      
      // 验证必要字段
      if (!config.version || !config.forcedRoutes || !config.preferredRoutes) {
        return false;
      }

      this.config = config;
      this.saveConfig(config);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 重置为默认配置
   */
  resetToDefault(): void {
    this.config = DEFAULT_CONFIG;
    this.saveConfig(DEFAULT_CONFIG);
    log.info('Reset to default config');
  }

  /**
   * 获取配置统计
   */
  getStats(): {
    forcedRoutesCount: number;
    preferredRoutesCount: number;
    totalHits: number;
  } {
    return {
      forcedRoutesCount: this.config.forcedRoutes.filter(r => r.enabled).length,
      preferredRoutesCount: this.config.preferredRoutes.filter(r => r.enabled).length,
      totalHits: (
        this.config.forcedRoutes.reduce((sum, r) => sum + (r.hitCount || 0), 0) +
        this.config.preferredRoutes.reduce((sum, r) => sum + (r.hitCount || 0), 0)
      ),
    };
  }
}

// 单例导出
export const routerConfig = new RouterConfigManager();

export default routerConfig;
