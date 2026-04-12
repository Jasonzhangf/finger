# 多轨（Multi-Track）实现计划

## 1. 背景与目标

当前 Finger 的会话系统每个 session 对应一个独立的 ledger 文件，无法在同一项目下同时维护多个相互隔离的对话轨道。

**目标**：
- 同一个项目的一个物理 ledger 文件内支持多个逻辑轨道（track0, track1, ...）。
- 每个 session 绑定一个 track，读写时按 track 隔离。
- 支持在纯文本通道（如 QQ、微信）中恢复时让用户选择轨道。
- 压缩（compact）也按 track 独立处理。

## 2. 核心设计

### 2.1 数据结构变更

#### Session 接口增加 `track` 字段
```typescript
// src/orchestration/session-types.ts
interface Session {
  // ... 现有字段
  track: string;        // "track0", "track1", ...
}
```
默认值：`"track0"`（兼容旧 session）。

#### Ledger 条目增加 `track` 字段
```json
{
  "id": "led-xxx",
  "timestamp_ms": ...,
  "session_id": "...",
  "agent_id": "...",
  "mode": "...",
  "track": "track0",
  "event_type": "...",
  "payload": {}
}
```

#### 新增项目级 track 元数据文件
路径：`~/.finger/projects/{project_hash}/tracks.json`
```json
{
  "tracks": {
    "track0": {
      "lastActiveAt": "2026-04-12T10:00:00Z",
      "preview": "用户：修复登录bug..."
    },
    "track1": {
      "lastActiveAt": "2026-04-12T11:30:00Z",
      "preview": "用户：分析性能数据..."
    }
  }
}
```
- `lastActiveAt`: 最后一次写入该 track 的时间（ISO 字符串）。
- `preview`: 该 track 最近一条用户消息的前 100 个字符（用于恢复时展示）。

### 2.2 写入流程

所有写入 ledger 的地方（`recordMessage`, `recordTurnStart`, `recordModelRound` 等）需从当前 session 读取 `track` 字段，并在写入的条目中添加 `track` 属性。

```typescript
// 伪代码
async function writeLedgerEntry(session: Session, eventType, payload) {
  const entry = {
    id: generateId(),
    timestamp_ms: Date.now(),
    session_id: session.id,
    agent_id: session.context?.ownerAgentId,
    mode: session.context?.sessionTier,
    track: session.track,          // 新增
    event_type: eventType,
    payload
  };
  await appendToLedgerFile(entry);
}
```

### 2.3 读取与过滤

`ContextLedgerMemory.query` 及内部读取函数在返回条目时，必须按当前 session 的 `track` 过滤：

```typescript
function filterEntriesByTrack(entries: LedgerEntry[], track: string): LedgerEntry[] {
  return entries.filter(e => (e.track || track0) === track);
}
```

缺失 `track` 的旧条目视为 `track0`。

### 2.4 压缩适配

压缩时（`compact` action）只处理当前 session 的 track 对应的事件。生成的 digest 也需带上 `track` 字段，存储在 `compact-memory.jsonl` 中。

恢复时加载 digest 同样只加载匹配当前 track 的条目。

### 2.5 Session 创建与 track 分配

创建新 session 时自动分配最小可用 track 编号：

1. 读取项目的 `tracks.json`。
2. 找出当前所有已存在的 track（例如 `track0`, `track1`）。
3. 如果某个 track 没有活跃 session（即未被任何 session 绑定），则复用该 track 编号。
4. 否则递增：`trackN`，N 为最大编号 + 1。
5. 创建 session 并设置 `session.track`。
6. 更新 `tracks.json` 中该 track 的 `lastActiveAt` 和 `preview`（可为空）。

```typescript
function allocateTrack(projectPath: string): string {
  const meta = loadTrackMeta(projectPath);
  const existingTracks = Object.keys(meta.tracks);
  for (let i = 0; ; i++) {
    const candidate = `track${i}`;
    if (!existingTracks.includes(candidate)) {
      return candidate;
    }
    // 如果该 track 没有被任何 session 使用，也可以复用
    if (!isTrackActive(candidate)) {
      return candidate;
    }
  }
}
```

### 2.6 恢复逻辑（纯文本通道）

当用户打开项目且没有指定 session 时：

1. 读取项目的 `tracks.json`。
2. 如果 `tracks` 对象中只有一个 track：直接恢复该 track（创建或复用 session）。
3. 如果有多个 track：
   - 系统自动回复一条消息，列出每个 track 及其预览（前 100 字节）。
   - 示例：
     ```
     检测到多个对话轨道：
     track0: "用户：帮我修复登录bug..."
     track1: "用户：分析性能数据..."
     请回复 `track0` 或 `track1` 继续。
     ```
   - 用户回复 `track0` 或 `track1` 后，系统恢复对应的 track。
4. 支持命令 `/resume track1` 直接切换。

**注意**：恢复时如果该 track 已有活跃 session，则直接复用；否则新建 session 并绑定该 track。

### 2.7 元数据更新时机

- 每次写入 ledger 后，更新对应 track 的 `lastActiveAt` 为当前时间。
- 如果写入的是用户消息（`role === user`），同时更新 `preview` 为该消息内容的前 100 字符。
- 关闭 session 时不删除 track 元数据，保留以便下次恢复。

## 3. 实施步骤

### Phase 1: 基础数据结构与写入
- [ ] 修改 `Session` 类型，增加 `track: string` 字段。
- [ ] 修改所有 ledger 写入代码，添加 `track` 字段。
- [ ] 实现 `tracks.json` 的读写模块。
- [ ] 修改 session 创建逻辑，实现自动分配 track。

### Phase 2: 读取过滤与压缩适配
- [ ] 修改所有 ledger 读取代码，增加按 track 过滤。
- [ ] 修改压缩逻辑（`compact` action），只处理当前 track 的事件。
- [ ] 确保 digest 也携带 track 字段。

### Phase 3: 恢复逻辑与文本交互
- [ ] 实现项目打开时的多 track 检测与选择逻辑。
- [ ] 实现 `/resume` 命令解析。
- [ ] 更新元数据（`lastActiveAt`, `preview`）的时机。

### Phase 4: 兼容性与测试
- [ ] 添加迁移逻辑：旧 session 自动补 `track = "track0"`。
- [ ] 旧 ledger 条目缺失 track 时视为 `track0`。
- [ ] 编写单元测试：多 track 写入/读取隔离、压缩隔离、恢复选择。
- [ ] 集成测试：模拟两个 track 交替写入，验证互不干扰。

## 4. 风险与注意事项

- **并发写入**：多个 session 同时写入同一 ledger 文件是安全的（append-only），但读取时需注意文件锁。
- **性能**：每次读取需要过滤 track，如果 ledger 很大，建议为每个 track 建立行索引（可后续优化）。
- **旧数据兼容**：确保缺失 `track` 的旧数据能正常读写。
- **纯文本通道的恢复体验**：列表不能太长（最多显示 5 个 track），否则刷屏。

## 5. 验收标准

- [ ] 两个不同的 session（track0 和 track1）写入同一项目，各自的 ledger 条目都带有正确的 track 字段。
- [ ] 读取 track0 时看不到 track1 的消息，反之亦然。
- [ ] 关闭所有 session 后重新打开项目，如果存在多个 track，系统会列出预览并等待用户选择。
- [ ] 选择 track 后能正确恢复对话历史。
- [ ] 压缩某个 track 不影响其他 track 的 digest。
- [ ] 旧项目（无 track 字段）打开后能正常工作，所有消息归入 track0。

## 6. 相关文件清单

- `src/orchestration/session-types.ts`
- `src/orchestration/session-manager.ts`
- `src/runtime/context-ledger-memory.ts`
- `src/runtime/context-ledger-memory-helpers.ts`
- `src/runtime/runtime-facade.ts`
- `src/server/routes/ledger-routes.ts`
- `src/tools/internal/context-ledger-memory-tool.ts`
- `src/server/modules/message-session.ts`
- 新增 `src/core/project-track-meta.ts`

## 7. 后续扩展

- 支持 UI 上的 track 切换下拉框（非纯文本通道）。
- 支持动态 context rebuild（相关性筛查后自动创建新 track）。
- 支持 track 归档与删除。
