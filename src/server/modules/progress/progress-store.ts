/**
 * Progress Store - 唯一数据存储
 * 
 * 只接受来自 'kernel_response' 的 ProgressUpdateEvent
 * 不接受其他来源的数据
 */

import type { ProgressSnapshot, ProgressUpdateEvent } from './progress-types.js';

class ProgressStore {
  private sessionProgress: Map<string, ProgressSnapshot> = new Map();
  
  /**
   * 更新 progress（只接受 kernel_response 来源）
   */
  update(event: ProgressUpdateEvent): void {
    // 唯一真源：只接受 kernel_response
    if (event.source !== 'kernel_response') {
      console.warn('[ProgressStore] Rejected non-kernel_response event:', event.source);
      return;
    }
    
    const key = `${event.sessionId}::${event.agentId}`;
    const existing = this.sessionProgress.get(key);
    
    // 构建 snapshot
    const snapshot: ProgressSnapshot = {
      sessionId: event.sessionId,
      agentId: event.agentId,
      projectPath: existing?.projectPath,
      
      // 最新 kernel metadata
      latestKernelMetadata: event.kernelMetadata,
      
      // 保留上一轮作为兜底
      previousKernelMetadata: existing?.latestKernelMetadata,
      
      // 上下文分解
      contextBreakdown: event.contextBreakdown,
      
      // 工具调用
      recentToolCalls: event.toolCalls || [],
      
      // 执行状态
      status: event.status || existing?.status || 'idle',
      currentTask: event.currentTask,
      latestStepSummary: event.lastTurnSummary,
      
      // 时间戳
      lastKernelResponseAt: event.timestamp,
      lastProgressUpdateAt: new Date(),
      
      // 团队状态（保留旧的）
      teamStatus: existing?.teamStatus,
      
      // Mailbox（保留旧的）
      mailboxStatus: existing?.mailboxStatus,
    };
    
    this.sessionProgress.set(key, snapshot);
  }
  
  /**
   * 获取 progress（用于渲染）
   */
  get(sessionId: string, agentId?: string): ProgressSnapshot | undefined {
    if (agentId) {
      return this.sessionProgress.get(`${sessionId}::${agentId}`);
    }
    
    // 如果没有 agentId，找 sessionId 相关的所有 snapshot
    for (const [key, snapshot] of this.sessionProgress.entries()) {
      if (key.startsWith(`${sessionId}::`)) {
        return snapshot;
      }
    }
    
    return undefined;
  }
  
  /**
   * 获取 kernel metadata（优先最新，兜底用上一轮）
   */
  getKernelMetadata(sessionId: string, agentId?: string): ProgressSnapshot['latestKernelMetadata'] | undefined {
    const snapshot = this.get(sessionId, agentId);
    if (!snapshot) return undefined;
    
    // 优先最新
    if (snapshot.latestKernelMetadata) {
      return snapshot.latestKernelMetadata;
    }
    
    // 兜底用上一轮
    return snapshot.previousKernelMetadata;
  }
  
  /**
   * 清除 session progress
   */
  clear(sessionId: string): void {
    for (const key of this.sessionProgress.keys()) {
      if (key.startsWith(`${sessionId}::`)) {
        this.sessionProgress.delete(key);
      }
    }
  }
  
  /**
   * 更新团队状态
   */
  updateTeamStatus(sessionId: string, teamStatus: ProgressSnapshot['teamStatus']): void {
    for (const [key, snapshot] of this.sessionProgress.entries()) {
      if (key.startsWith(`${sessionId}::`)) {
        snapshot.teamStatus = teamStatus;
      }
    }
  }
  
  /**
   * 更新 mailbox 状态
   */
  updateMailboxStatus(sessionId: string, agentId: string, mailboxStatus: ProgressSnapshot['mailboxStatus']): void {
    const key = `${sessionId}::${agentId}`;
    const snapshot = this.sessionProgress.get(key);
    if (snapshot) {
      snapshot.mailboxStatus = mailboxStatus;
    }
  }
}

// 单例
export const progressStore = new ProgressStore();
