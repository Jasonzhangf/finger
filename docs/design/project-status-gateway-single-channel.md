# Project Status Gateway（Single Channel）Design

Status: Draft (for implementation)  
Owner: System runtime / orchestration  
Last updated: 2026-04-03

---

## 1. 背景与问题

当前项目状态虽然已有 `projectTaskState/projectTaskRegistry/runtime_view` 等信息源，但存在三个现实问题：

1. 多入口读写：UI、Agent、heartbeat、dispatch lifecycle 会各自拼装状态，容易出现“同一时刻不同结论”。
2. 状态漂移：存在运行态（runtime）与任务态（project task）不同步窗口，导致误判重复派发或误报空闲。
3. 闭环不完整：上层想“问进度/继续推理”时，缺少统一 correlation 与统一状态回写口。

目标是把“项目状态”收敛为一个小而硬的状态机网关，让所有授权渠道都通过它获取与更新。

---

## 2. 目标与非目标

### 2.1 目标（必须）

1. 唯一状态通道：所有外部读取项目进度的路径（UI 通知、agent 感知、心跳巡检）统一读 `ProjectStatusGateway`。
2. 唯一写入通道：dispatch/review/report/update 等状态写入只能通过 gateway 事件化写入。
3. 状态机硬约束：状态迁移必须经过合法校验（含 blocked_by、task identity、revision）。
4. 非打断式进度感知：默认读状态快照，不打断执行；仅在快照冲突/超时时触发异步询问。
5. 全链路可追踪：每次状态变更携带 correlation（taskId/dispatchId/requestId/revision）。

### 2.2 非目标（本轮不做）

1. 不改动上下文压缩算法本体。
2. 不引入新模型 provider。
3. 不在本 epic 内实现完整 FLOW/skills 策略模板（后续阶段）。

---

## 3. 核心原则

1. Read/Write 分离：
   - 写：事件命令（dispatch/report/review/update/control）
   - 读：一致性快照（status view）
2. Session 只作为执行绑定，不作为状态真源。
3. gateway 是唯一“可授权外部渠道”：
   - UI
   - system agent
   - project agent
   - reviewer
   - heartbeat/watchdog
4. 失败可恢复，不可静默：
   - 迁移失败返回明确错误 + 保持原状态
   - 记录标准日志

---

## 4. 架构总览

```text
Dispatch / Report / Review / Update / Heartbeat events
                     |
                     v
        ProjectStatusGateway (state machine)
                     |
     +---------------+----------------+
     |                                |
Persistent Store                 Snapshot Bus
(projectTaskState +              (UI / agent status
 projectTaskRegistry +            / scheduler view)
 event journal)
```

### 4.1 写入入口（统一）

- Dispatch lifecycle events
- `report-task-completion`
- `project.task.update`
- reviewer verdict events
- heartbeat recovery actions（仅状态相关部分）

### 4.2 读取入口（统一）

- `project.task.status`（升级为 gateway-backed view）
- progress monitor
- UI progress push
- system 调度前检查

---

## 5. 状态模型

以现有约束为准并对齐用户要求：

`create -> dispatched -> accepted -> in_progress -> claiming_finished -> reviewed -> reported -> closed`

分支态：`blocked | failed | cancelled`

### 5.1 关键字段（最小必需）

- identity: `taskId | taskName`
- routing: `sourceAgentId | targetAgentId | boundSessionId`
- ownership: `assignerName | assigneeWorkerId | assigneeWorkerName | reviewerName`
- control: `dispatchId | revision | blockedBy`
- evidence: `summary | note | updatedAt`
- correlation: `requestId | parentDispatchId | workflowId(optional)`

### 5.2 迁移守卫

1. 必填 blocked_by：
   - 无阻塞必须显式 `['none']`
   - 禁止 `none` 与真实依赖混用
2. 同 task 续跑必须同 identity（taskId/taskName）
3. revision 单调递增
4. 非法迁移拒绝（不写盘）

---

## 6. 非打断式进度策略

### 6.1 默认路径（不打断）

System 读取 gateway 快照获得：
- 当前状态
- owner/worker
- 最近进展
- 阻塞项
- 下一步（若有）

### 6.2 触发询问（兜底）

仅当命中任一条件：
- 状态超过阈值未更新（stale）
- runtime 与 task state 冲突
- 缺关键字段（证据/阻塞/next）

询问必须：
- 异步（queue/mailbox）
- 带 requestId/correlation
- 回复后自动回写 gateway 并供 system 下一步继续推理

---

## 7. API/工具契约（实现目标）

### 7.1 Gateway 写接口（内部）

- `applyEvent(event)`
  - 输入：标准化事件（dispatch_started/review_passed/...）
  - 输出：新快照 + diff

### 7.2 Gateway 读接口（内部）

- `getProjectSnapshot(projectPath, filters)`
- `getTaskSnapshot(taskId|taskName)`
- `getStaleTasks(thresholdSec)`

### 7.3 Tool 侧（对模型暴露）

- `project.task.status`：统一由 gateway 快照返回
- `project.task.update`：调用 gateway 写接口，不得绕过
- （后续）`project.task.watch`：订阅变更（可选）

---

## 8. 数据持久化

保持现有文件语义，新增“统一写入顺序”：

1. 先内存 applyEvent + 校验
2. 再持久化 `projectTaskState/projectTaskRegistry`
3. 再写 TASK.md router（派生视图）
4. 最后广播 UI/agent 事件

任何一步失败：
- 保留错误日志
- 不广播成功态
- 允许重试

---

## 9. 并发与一致性

1. 锁粒度：按 `projectPath + taskIdentity` 串行 apply
2. 幂等键：`dispatchId + phase + revision`
3. 去重窗口：防止重复事件污染
4. 事件乱序：按 revision + timestamp 处理，旧 revision 拒收

---

## 10. 测试策略

### 10.1 单元测试

- 合法/非法状态迁移
- blocked_by 校验
- revision 单调性
- 幂等与乱序
- stale 判定

### 10.2 集成测试

- system -> project -> reviewer -> system 全链路闭环
- 重启恢复后状态一致
- 同项目多 worker 非阻塞并行
- busy 场景下默认不问 agent，仅读状态

### 10.3 回归断言

- 不出现“状态已完成但快照仍 in_progress”
- 不出现“同 task 重复派发”
- UI 与 agent 看到同一状态版本

---

## 11. 迁移计划（分阶段）

### Phase A：网关内聚

- 引入 `ProjectStatusGateway` 与标准事件模型
- 把现有 `project.task.status/update` 切到 gateway
- 保持外部接口不破坏

### Phase B：调度闭环

- system dispatch 前强制 gateway precheck
- reviewer/report 回写统一经 gateway
- 增加 stale 监控与兜底询问触发

### Phase C：多 agent 交互基础能力

- 跨 agent query/progress 的 correlation 对齐 gateway
- 异步等待/恢复统一挂接 gateway 状态
- 为 FLOW / skills 输出稳定输入面

### Phase D：FLOW 与 Skills 落地

- 以 gateway 快照为唯一事实输入
- 输出可执行 flow 模板与 skills 路由规范

---

## 12. 验收标准（Epic 级）

1. 所有项目状态读取渠道统一来自 gateway 快照。
2. 所有项目状态写入路径统一走 gateway applyEvent。
3. 默认进度获取不打断执行；询问仅在 stale/冲突/缺字段触发。
4. 询问回复可回写状态并支持 system 自动继续后续推理。
5. 同项目多 worker 并行场景下状态一致，不重复派发，不丢状态。

