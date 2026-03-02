 /**
  * Session Logger - Session 级别完整日志落盘
  * 
  * 保存:
  * - Session 元数据 (agentId, taskId, start/end, stopReason)
  * - iFlow sessionId
  * - 轮次摘要
  * - Action 序列
  * - 最终结果
  */
 
import fs from 'fs';
import path from 'path';
import { ensureDir, ensureFingerLayout, FINGER_PATHS } from '../../core/finger-paths.js';

ensureFingerLayout();
const SESSION_DIR = ensureDir(path.join(FINGER_PATHS.logs.dir, 'sessions'));
 
 export interface SessionIteration {
   round: number;
   action: string;
   thought: string;
   params: Record<string, unknown>;
   reviewApproved?: boolean;
   reviewFeedback?: string;
   observation?: string;
   success: boolean;
   duration: number;
   timestamp: string;
 }
 
 export interface SessionData {
   // 元数据
   sessionId: string;
   agentId: string;
   agentRole: string;
   iflowSessionId?: string;
   
   // 任务信息
   taskId?: string;
   userTask: string;
   
   // 时间
   startTime: string;
   endTime?: string;
   duration?: number;
   
   // 停止
   stopReason?: string;
   success: boolean;
   
   // 轮次
   iterations: SessionIteration[];
   totalRounds: number;
   
   // 结果
   finalOutput?: string;
   finalError?: string;
   
   // 统计
   stats: {
     totalActions: number;
     successActions: number;
     failedActions: number;
     rejectedActions: number;
     avgDurationPerRound: number;
   };
 }
 
 export class SessionLogger {
   private data: SessionData;
   private filePath: string;
   private startMs: number;
 
   constructor(agentId: string, agentRole: string, userTask: string, taskId?: string) {
     const sessionId = `${agentId}-${Date.now()}`;
     this.startMs = Date.now();
     
     this.data = {
       sessionId,
       agentId,
       agentRole,
       taskId,
       userTask,
       startTime: new Date().toISOString(),
       success: false,
       iterations: [],
       totalRounds: 0,
       stats: {
         totalActions: 0,
         successActions: 0,
         failedActions: 0,
         rejectedActions: 0,
         avgDurationPerRound: 0,
       },
     };
     
     this.filePath = path.join(SESSION_DIR, `${sessionId}.json`);
     this.save();
   }
 
   setIFlowSessionId(iflowSessionId: string): void {
     this.data.iflowSessionId = iflowSessionId;
   }
 
   addIteration(iteration: SessionIteration): void {
     this.data.iterations.push(iteration);
     this.data.totalRounds = this.data.iterations.length;
     this.data.stats.totalActions++;
     
     if (iteration.success) {
       this.data.stats.successActions++;
     } else if (!iteration.reviewApproved) {
       this.data.stats.rejectedActions++;
     } else {
       this.data.stats.failedActions++;
     }
     
     this.save();
   }
 
   complete(success: boolean, stopReason: string, output?: string, error?: string): void {
     this.data.success = success;
     this.data.stopReason = stopReason;
     this.data.finalOutput = output;
     this.data.finalError = error;
     this.data.endTime = new Date().toISOString();
     this.data.duration = Date.now() - this.startMs;
     
     if (this.data.totalRounds > 0) {
       this.data.stats.avgDurationPerRound = Math.round(this.data.duration / this.data.totalRounds);
     }
     
     this.save();
   }
 
   private save(): void {
     fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
   }
 
   getSessionId(): string {
     return this.data.sessionId;
   }
 
   getData(): SessionData {
     return { ...this.data };
   }
 }
 
 export function createSessionLogger(
   agentId: string,
   agentRole: string,
   userTask: string,
   taskId?: string
 ): SessionLogger {
   return new SessionLogger(agentId, agentRole, userTask, taskId);
 }
