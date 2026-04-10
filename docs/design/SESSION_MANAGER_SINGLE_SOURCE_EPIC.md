# Session Manager Single Source Epic (finger-285)

## 概述
统一 Session 管理为唯一真源，解决上下文断裂、session 漂移、类型冲突问题。

## 当前问题

### 散乱的 Manager 实现（4 个）
| Manager | 文件 | 行数 | 功能 |
|---------|------|------|------|
| SessionManager | orchestration/session-manager.ts | 2277 | Ledger、Context Builder、压缩、ownership |
| MemorySessionManager | agents/base/memory-session-manager.ts | ~120 | 简化版，无 Ledger |
| ResumableSessionManager | orchestration/resumable-session.ts | ~394 | 可恢复 session |
| CodexExecSessionManager | tools/internal/codex-exec-session-manager.ts | ~120 | codex exec 专用 |

### 类型冲突（2 个 Session 类型）
- `chat/session-types.ts` → 旧版（无 projectPath）
- `orchestration/session-types.ts` → 新版（完整 Ledger 指针）

### 引用散乱
- kernel-agent-base、memory-session-manager 用旧的
- session-manager、message-preflight-compact、projects route 用新的

## 目标架构

### 唯一真源
```
orchestration/session-types.ts
  ├─ Session 接口（含 projectPath + Ledger 指针）
  ├─ SessionMessage 接口
  ├─ ISessionManager 接口（统一）
  └─ 导出所有类型

orchestration/session-manager.ts
  └─ SessionManager 类（唯一实现）
```

### 删除清单
1. `src/agents/base/memory-session-manager.ts`
2. `src/agents/chat/session-types.ts`
3. `src/orchestration/resumable-session.ts`
4. `src/tools/internal/codex-exec-session-manager.ts`
5. `runtime/runtime-facade.ts` 中的 ISessionManager

### 引用统一
所有文件改用 `orchestration/session-types.js`

## Phase 分解

### Phase 1: 类型统一
1. 扩展 `orchestration/session-types.ts`：
   - 添加 `title`、`status`、`messageCount` 字段（兼容旧版）
   - 导出统一 `ISessionManager` 接口
2. 删除 `chat/session-types.ts`
3. 全局替换 import

### Phase 2: 移除冗余 Manager
1. 删除 `memory-session-manager.ts`
2. 删除 `resumable-session.ts`
3. 删除 `codex-exec-session-manager.ts`
4. 删除 `runtime-facade.ts` 中 ISessionManager
5. 更新所有引用点

### Phase 3: kernel-agent-base.ts 修复
1. 改用统一 Session/SessionMessage 类型
2. 改用 SessionManager（移除 MemorySessionManager fallback）
3. `tryBuildContextBuilderHistory` 接入 Context Builder
4. 修复类型匹配问题

### Phase 4: 清理与验证
1. TypeScript 编译通过
2. 测试通过
3. 清理 dist/ 残留

## Session 设计原则

### Session 管理
- 默认一个 project = 一个 session
- Ledger 只有一个，按时间顺序
- Session new/switch 是 dynamic view
- Heartbeat/定时任务 = stateless session（内存中存在）
- Heartbeat 任务需 agent assign + 必要参数

### 多窗口问题
- 各窗口独立 session + ledger track
- MemPalace 索引合并
- Context rebuild 自动整合

### Reviewer 移除
- 只保留 system + project agent
- System agent 用原 session review（复用 thread）

## 涉及文件

### 删除（5 个）
- `chat/session-types.ts`
- `memory-session-manager.ts`
- `resumable-session.ts`
- `codex-exec-session-manager.ts`
- `runtime-facade.ts` 中 ISessionManager 接口定义

### 修改
- `orchestration/session-types.ts`（扩展）
- `kernel-agent-base.ts`（类型 + Manager）
- `runtime-facade.ts`（改用统一导出）
- `cli.ts`（不变，继续用 SessionManager）
- `codex-exec-tools.ts`（改用 SessionManager）
- `workflow-manager-instance.ts`（不变）
- `shared-instances.ts`（不变）
- 全局 import 替换

### 不变
- `orchestration/session-manager.ts`（已经是真源）

## 验收标准
- [ ] TypeScript 编译零错误
- [ ] 所有测试通过
- [ ] Session 类型唯一真源
- [ ] ISessionManager 接口唯一
- [ ] SessionManager 实现唯一
- [ ] kernel-agent-base 正确接入 Context Builder
- [ ] 无残留旧类型/Manager 引用

## 关联
- Epic: finger-285
- Memory: #mem-session-single-source-20260409
