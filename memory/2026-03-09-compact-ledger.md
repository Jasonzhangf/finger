# 2026-03-09 Compact + Ledger 集成实现

## 概述
实现自动 compact + ledger 集成功能，包括：
- 自动压缩阈值设置为 85% 上下文窗口
- 两级记忆系统（原始记忆 + compact summary）
- Ledger API 支持 search/index/compact
- Source time/slot 对齐逻辑

## 已完成工作

### 1. API 类型修复
- 修复 `ui/src/api/types.ts` 损坏的 RuntimeEvent 接口
- 添加全局唯一真源驱动字段：
  - `roleType`: agent 角色类型
  - `assignerId`: 任务分配者 ID
  - `assignerName`: 任务分配者名称
  - `instanceName`: 多实例名称
  - `sessionType`: 主/子会话类型

### 2. Compact + Ledger 核心实现
- `src/runtime/context-ledger-memory-types.ts`
  - 新增 actions: `search`, `index`, `compact`
  - 新增 compact/index 结果类型
  - 新增 compact metadata 字段

- `src/runtime/context-ledger-memory.ts`
  - 实现 `executeIndexAction`
  - 实现 `executeCompactAction`
  - query/search 返回 `action: 'query' | 'search'`
  - compact search hits 包含 slot + trigger metadata

- `src/runtime/runtime-facade.ts`
  - `compressContext` 持久化 compact 信息到 ledger
  - 新增 `maybeAutoCompact(sessionId, contextUsagePercent, turnId)`
  - 自动压缩阈值设为 85%

### 3. 自动压缩触发路径
- `src/server/modules/event-forwarding.ts`
  - 发送 `system_notice` 事件 (`auto_compact_probe`)
- `src/server/index.ts`
  - 订阅 `system_notice` 并调用 `runtime.maybeAutoCompact`

### 4. UI 支持
- `ui/src/hooks/useWorkflowExecution.ts`
  - 处理 `session_compressed` WebSocket 事件
  - 更新压缩计数和状态显示

## 架构决策
1. **自动压缩阈值**: 85% context window
2. **两级记忆**: 原始历史 + compact summaries
3. **内置 API**: 所有 memsearch-like 功能通过 ledger 提供
4. **对齐策略**: source time/slot 在压缩前后保持对齐

## 后续任务
- [ ] 添加单元测试
  - context-ledger-memory index/compact 测试
  - runtime-facade 自动压缩触发测试
- [ ] 验证自动压缩路径
- [ ] 端到端测试

Tags: compact, ledger, memory, auto-compact, implementation
