/**
 * AgentRegistry - Project Agent 内部子 agent 并发控制
 * 
 * 功能：
 * - 活跃 agent 跟踪（agent_tree）
 * - 总数计数（total_count）
 * - Nickname 自动分配
 * - Spawn slot 预留（RAII SpawnReservation）
 * - 深度限制检查
 */

import { logger } from '../core/logger.js';

const log = logger.module('AgentRegistry');

// Nickname 候选池（参考 Codex role.rs）
const DEFAULT_NICKNAME_CANDIDATES = [
  'Explorer', 'Worker', 'Coder', 'Analyzer', 'Runner',
  'Helper', 'Assistant', 'Agent', 'Solver', 'Builder',
];

// 角色专属候选池
const ROLE_NICKNAME_MAP: Record<string, string[]> = {
  'explorer': ['Explorer', 'Scanner', 'Seeker', 'Hunter', 'Finder'],
  'worker': ['Worker', 'Builder', 'Maker', 'Craftsman', 'Producer'],
  'coder': ['Coder', 'Developer', 'Hacker', 'Programmer', 'Engineer'],
  'reviewer': ['Reviewer', 'Auditor', 'Inspector', 'Critic', 'Judge'],
  'awaiter': ['Watcher', 'Monitor', 'Observer', 'Guard', 'Sentinel'],
};

/**
 * Agent 元数据
 */
export interface AgentMetadata {
  agentId?: string;
  agentPath: string;        // 层级路径如 "/root/explorer/worker-1"
  agentNickname: string;
  agentRole?: string;
  lastTaskMessage?: string;
  spawnDepth: number;
  status: 'pending' | 'active' | 'closed';
  createdAt: string;
  updatedAt?: string;
}

/**
 * Spawn 预留选项
 */
export interface SpawnReservationOptions {
  maxThreads?: number;      // 最大并发子 agent 数
  agentPath?: string;       // 指定路径（可选）
  agentNickname?: string;   // 指定昵称（可选）
  agentRole?: string;       // 角色（用于 nickname 池选择）
  spawnDepth?: number;      // spawn 深度
}

/**
 * Spawn 预留（RAII guard）
 */
export interface SpawnReservation {
  readonly committed: boolean;
  readonly reservedNickname: string;
  readonly reservedPath?: string;
  commit(metadata: Partial<AgentMetadata>): void;
  rollback(): void;
}

/**
 * Agent 注册表
 */
export class AgentRegistry {
  private activeAgents: Map<string, AgentMetadata> = new Map();
  private totalCount: number = 0;
  private usedNicknames: Set<string> = new Set();
  private nicknameResetCount: number = 0;
  private nicknamePoolIndex: number = 0;

  constructor() {
    log.debug('AgentRegistry initialized');
  }

  /**
   * 预留 spawn slot（RAII）
   * @throws Error if maxThreads limit reached
   */
  reserveSpawnSlot(options: SpawnReservationOptions = {}): SpawnReservation {
    const { maxThreads, agentPath, agentNickname, agentRole, spawnDepth = 0 } = options;

    // 检查线程数限制
    if (maxThreads !== undefined && this.totalCount >= maxThreads) {
      log.warn('Spawn slot rejected: max threads reached', { maxThreads, current: this.totalCount });
      throw new Error(`Agent limit reached: max_threads=${maxThreads}`);
    }

    // 预留 nickname
    const reservedNickname = agentNickname ?? this.reserveNickname(agentRole);
    
    // 预留计数
    this.totalCount++;
    log.debug('Spawn slot reserved', { reservedNickname, totalCount: this.totalCount });

    // 创建 RAII guard
    const reservation: SpawnReservation = {
      committed: false,
      reservedNickname,
      reservedPath: agentPath,
      commit: (metadata: Partial<AgentMetadata>) => {
        if (reservation.committed) {
          log.warn('Reservation already committed', { reservedNickname });
          return;
        }

        const fullMetadata: AgentMetadata = {
          agentId: metadata.agentId,
          agentPath: metadata.agentPath ?? agentPath ?? `/root/${reservedNickname.toLowerCase()}`,
          agentNickname: reservedNickname,
          agentRole: metadata.agentRole ?? agentRole,
          lastTaskMessage: metadata.lastTaskMessage,
          spawnDepth: spawnDepth,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };

        this.activeAgents.set(fullMetadata.agentPath, fullMetadata);
        // @ts-expect-error - readonly field mutation for internal state
        reservation.committed = true;
        log.info('Agent registered', { agentPath: fullMetadata.agentPath, nickname: reservedNickname });
      },
      rollback: () => {
        if (reservation.committed) {
          log.warn('Reservation already committed, cannot rollback', { reservedNickname });
          return;
        }

        this.totalCount--;
        this.releaseNickname(reservedNickname);
        // @ts-expect-error - readonly field mutation for internal state
        reservation.committed = true; // Mark as consumed
        log.debug('Spawn slot rolled back', { reservedNickname, totalCount: this.totalCount });
      },
    };

    return reservation;
  }

  /**
   * 释放已关闭的 agent
   */
  releaseSpawnedThread(agentPath: string): void {
    const agent = this.activeAgents.get(agentPath);
    if (!agent) {
      log.warn('Agent not found for release', { agentPath });
      return;
    }

    agent.status = 'closed';
    agent.updatedAt = new Date().toISOString();
    this.totalCount--;
    this.releaseNickname(agent.agentNickname);
    
    // 从活跃列表移除（可选保留历史）
    this.activeAgents.delete(agentPath);
    
    log.info('Agent released', { agentPath, totalCount: this.totalCount });
  }

  /**
   * 计算子深度
   */
  getNextDepth(parentDepth: number): number {
    return parentDepth + 1;
  }

  /**
   * 检查是否超出深度限制
   */
  exceedsDepthLimit(depth: number, maxDepth: number): boolean {
    return depth > maxDepth;
  }

  /**
   * 按 path 查询 agent
   */
  getAgentByPath(path: string): AgentMetadata | undefined {
    return this.activeAgents.get(path);
  }

  /**
   * 按 nickname 查询 agent
   */
  getAgentByNickname(nickname: string): AgentMetadata | undefined {
    for (const agent of this.activeAgents.values()) {
      if (agent.agentNickname === nickname) {
        return agent;
      }
    }
    return undefined;
  }

  /**
   * 列出活跃 agent（可选 path 前缀筛选）
   */
  listAgents(pathPrefix?: string): AgentMetadata[] {
    const agents = Array.from(this.activeAgents.values());
    if (!pathPrefix) {
      return agents;
    }
    return agents.filter(a => a.agentPath.startsWith(pathPrefix));
  }

  /**
   * 获取当前总数
   */
  getTotalCount(): number {
    return this.totalCount;
  }

  /**
   * 获取活跃 agent 数量
   */
  getActiveCount(): number {
    return this.activeAgents.size;
  }

  /**
   * 预留 nickname（内部）
   */
  private reserveNickname(role?: string): string {
    // 1. 尝试角色专属池
    if (role && ROLE_NICKNAME_MAP[role]) {
      const rolePool = ROLE_NICKNAME_MAP[role];
      for (const candidate of rolePool) {
        if (!this.usedNicknames.has(candidate)) {
          this.usedNicknames.add(candidate);
          log.debug('Nickname reserved from role pool', { nickname: candidate, role });
          return candidate;
        }
      }
    }

    // 2. 尝试默认池
    const defaultPool = DEFAULT_NICKNAME_CANDIDATES;
    for (let i = this.nicknamePoolIndex; i < defaultPool.length; i++) {
      const candidate = defaultPool[i];
      if (!this.usedNicknames.has(candidate)) {
        this.usedNicknames.add(candidate);
        this.nicknamePoolIndex = i + 1;
        log.debug('Nickname reserved from default pool', { nickname: candidate });
        return candidate;
      }
    }

    // 3. Pool exhausted - 使用后缀版本
    // 选择一个 base name，加 "the Nth" 后缀
    const baseName = (role && ROLE_NICKNAME_MAP[role]?.[0]) ?? defaultPool[0];
    const nth = this.nicknameResetCount + 2; // "the 2nd", "the 3rd", ...
    
    let suffix: string;
    if (nth === 2) suffix = 'the 2nd';
    else if (nth === 3) suffix = 'the 3rd';
    else suffix = `the ${nth}th`;

    const finalNickname = `${baseName} ${suffix}`;
    this.usedNicknames.add(finalNickname);
    this.nicknameResetCount++;
    
    log.debug('Nickname reserved with suffix', { nickname: finalNickname, resetCount: this.nicknameResetCount });
    return finalNickname;
  }

  /**
   * 释放 nickname（内部）
   */
  private releaseNickname(nickname: string): void {
    this.usedNicknames.delete(nickname);
    log.debug('Nickname released', { nickname });
  }

  /**
   * 更新 agent 状态
   */
  updateAgentStatus(agentPath: string, status: 'pending' | 'active' | 'closed'): void {
    const agent = this.activeAgents.get(agentPath);
    if (!agent) {
      log.warn('Agent not found for status update', { agentPath });
      return;
    }
    agent.status = status;
    agent.updatedAt = new Date().toISOString();
    log.debug('Agent status updated', { agentPath, status });
  }

  /**
   * 更新 agent lastTaskMessage
   */
  updateAgentTaskMessage(agentPath: string, message: string): void {
    const agent = this.activeAgents.get(agentPath);
    if (!agent) {
      log.warn('Agent not found for task message update', { agentPath });
      return;
    }
    agent.lastTaskMessage = message;
    agent.updatedAt = new Date().toISOString();
    log.debug('Agent task message updated', { agentPath });
  }

  /**
   * 清空注册表（测试用）
   */
  clear(): void {
    this.activeAgents.clear();
    this.usedNicknames.clear();
    this.totalCount = 0;
    this.nicknameResetCount = 0;
    this.nicknamePoolIndex = 0;
    log.debug('AgentRegistry cleared');
  }
}

export { DEFAULT_NICKNAME_CANDIDATES, ROLE_NICKNAME_MAP };
