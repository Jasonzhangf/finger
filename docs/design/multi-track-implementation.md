# 多轨（Multi-Track）功能实现计划

## 概述
为 Finger 项目增加多轨道（track）支持，允许多个独立对话/任务在同一 ledger 文件中共存，轨道之间完全隔离。  
支持自动分配 track、恢复时选择轨道、压缩按 track 隔离。

## 核心修改点

### 1. 数据结构
- **Session 接口**（`src/orchestration/session-types.ts`）  
  增加字段：`track: string`（默认 `"track0"`）
- **Ledger 条目**（写入 `context-ledger.jsonl` 的 JSON 对象）  
  增加字段：`track: string`
- **Compact 条目**（`compact-memory.jsonl`）  
  增加字段：`track: string`

### 2. 元数据管理
- 新增文件：`~/.finger/projects/{project_hash}/tracks.json`  
  结构：
  ```json
  {
    "track0": { "lastActiveAt": "ISO时间", "preview": "前100字符" },
    "track1": { ... }
  }
  ```
- 实现模块：`src/runtime/track-metadata.ts`（读写、查询、更新）

### 3. Session 创建与 track 分配
- 修改 `SessionManager.createSession`  
  - 调用 `allocateTrack(projectPath)` 获取可用 track（优先复用已关闭的 track，否则递增）
  - 将 `track` 写入 session 对象
  - 更新 `tracks.json` 中对应 track 的 `lastActiveAt` 和 `preview`

### 4. Ledger 读写过滤
- 所有写入 ledger 的地方（`RuntimeFacade.recordMessage`、`recordTurnStart` 等）  
  - 从当前 session 读取 `track`，写入时带上该字段
- 所有读取 ledger 的地方（`ContextLedgerMemory.query`）  
  - 增加过滤条件：只返回 `entry.track === session.track` 的记录

### 5. 压缩（Compact）适配
- `executeCompactAction` 在读取 ledger 时按 `track` 过滤
- 生成的 compact 条目（`compact-memory.jsonl`）写入时带上 `track`
- 恢复压缩摘要时，只加载匹配当前 track 的条目

### 6. 恢复逻辑（多 track 选择）
- 项目启动时，调用 `getAvailableTracks(projectPath)` 读取 `tracks.json`
- 如果只有一个 track：直接恢复该 track 的 session
- 如果有多个 track：
  - 系统自动回复消息，列出每个 track 的前 100 字符预览
  - 等待用户输入 `track0` 或 `track1` 等选择
  - 根据选择创建/恢复对应 track 的 session
- 支持命令 `/resume track1` 直接切换

### 7. 兼容性处理
- 旧 ledger 文件无 `track` 字段 → 读取时视为 `track = "track0"`
- 旧 session 对象无 `track` 字段 → 创建 session 时自动赋值 `"track0"`

## 实施步骤（任务分解）

1. **Task 1: 类型定义与元数据模块**  
   - 修改 `Session` 接口增加 `track`  
   - 创建 `track-metadata.ts` 实现 `tracks.json` 读写  
   - 添加单元测试

2. **Task 2: Session 创建时 track 分配**  
   - 修改 `createSession` 逻辑  
   - 集成元数据更新  
   - 添加集成测试

3. **Task 3: Ledger 写入/读取增加 track 过滤**  
   - 修改所有写入点，带上 session.track  
   - 修改 `ContextLedgerMemory.query` 增加 track 过滤  
   - 单元测试验证隔离性

4. **Task 4: 压缩适配**  
   - 修改 `executeCompactAction` 按 track 过滤  
   - compact 条目写入 track 字段  
   - 测试多 track 压缩互不干扰

5. **Task 5: 恢复选择逻辑**  
   - 实现项目启动时检测多 track  
   - 实现文本交互选择  
   - 实现 `/resume` 命令  
   - 端到端测试

6. **Task 6: 旧数据迁移与兼容性**  
   - 启动时自动迁移旧 session 添加 `track="track0"`  
   - 验证旧 ledger 文件可正常读取

## 验收标准
- [ ] 同一项目可创建多个 track（track0, track1, ...）  
- [ ] 每个 track 的对话历史完全隔离  
- [ ] 关闭项目后重新打开，能检测到多个 track 并提供选择  
- [ ] 压缩只针对当前 track 的事件  
- [ ] 所有现有功能（单 track）不受影响  

## 相关文件
- `src/orchestration/session-types.ts`
- `src/orchestration/session-manager.ts`
- `src/runtime/context-ledger-memory.ts`
- `src/runtime/runtime-facade.ts`
- `src/runtime/track-metadata.ts`（新建）
- `src/server/routes/session.ts`（可能涉及恢复接口）
