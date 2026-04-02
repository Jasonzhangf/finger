# Worker Pool Runtime Design（System → Worker → Project）

## 1. 背景与目标

当前实现将项目执行主要收敛到单一 `finger-project-agent` 抽象，导致：

1. 不同项目在运行时层面争用同一 busy/queue 状态；
2. System 派发到“另一个项目”时仍可能被同一运行队列影响；
3. “谁在负责某个项目任务”在状态机里不够显式，恢复与 review 责任边界不清晰。

本设计目标：

1. **System Agent 全局唯一**（工头，`instance=1`）；
2. **Project Worker 池化**（`N` 个 worker，可配置）；
3. **Worker 负责制**：任务派发、恢复、review 都绑定具体 worker，而不是抽象 project-agent；
4. **并行隔离**：不同 worker 并行执行互不干扰；
5. **可恢复**：重启后按 project→worker 绑定关系恢复未完成任务。

---

## 2. 核心实体与关系

### 2.1 角色

- **System Agent**：唯一调度者，负责计划、派发、汇总、对用户报告。
- **Project Worker**：执行者（多个），每个 worker 有独立身份与会话生命周期。
- **Reviewer Agent**：审查者，不做执行，不再反向派发实现任务。

### 2.2 绑定关系

- `projectTaskState.assigneeWorkerId`：当前任务执行责任人（worker）。
- `projectTaskState.deliveryWorkerId`：提交交付的 worker（通常等于 assignee）。
- `projectTaskState.reviewerId`：负责 review 的 reviewer。

---

## 3. 配置设计（唯一真源）

新增（或扩展）`~/.finger/config/orchestration.json` 的 worker 池配置：

```json
{
  "runtime": {
    "systemAgent": {
      "id": "finger-system-agent",
      "maxInstances": 1
    },
    "projectWorkers": {
      "maxWorkers": 6,
      "autoNameOnFirstAssign": true,
      "nameCandidates": [
        "Alex", "Maya", "Leo", "Nora", "Iris",
        "Ethan", "Luna", "Owen", "Zoe", "Noah",
        "Mila", "Ryan", "Ava", "Eli", "Ruby",
        "Liam", "Aria", "Jack", "Emma", "Kai"
      ],
      "workers": [
        { "id": "finger-worker-01", "name": "Alex", "enabled": true },
        { "id": "finger-worker-02", "name": "Maya", "enabled": true }
      ]
    },
    "reviewers": {
      "maxInstances": 2,
      "reviewerName": "Sentinel",
      "agents": [
        { "id": "finger-reviewer-01", "name": "Sentinel-A", "enabled": true },
        { "id": "finger-reviewer-02", "name": "Sentinel-B", "enabled": true }
      ]
    }
  }
}
```

规则：

1. `systemAgent.maxInstances` 固定为 1；
2. `projectWorkers.maxWorkers` 为池上限；
3. `workers[].name` 允许为空；首次分配时自动生成人名并**写回配置**；
4. worker `id` 稳定不变（用于持久化关联）。
5. reviewer 独立配置，默认最多 2 个 runtime（可降为 1）。

---

## 4. Worker 身份与私有上下文

每个 worker 拥有独立私有目录：

- `~/.finger/workers/<workerId>/SOUL.md`
- `~/.finger/workers/<workerId>/MEMORY.md`（可选）

用途：

1. `SOUL.md`：长期行为偏好/工作风格；
2. `MEMORY.md`：私有经验记忆（可为空，不强制）。

隔离约束：

1. worker 只能消费自身 private memory；
2. project 级任务状态由 project context 持久化，不写入别的 worker 私有区；
3. reviewer 不写 worker 私有记忆，只写 review 结果。

---

## 5. 运行时并行模型（关键）

### 5.1 运行隔离键（Execution Lane）

调度与并发统计从 `targetAgentId` 升级为：

`laneKey = projectId + ":" + workerId + ":" + sessionId`

按 laneKey 进行：

1. active dispatch count
2. busy 判定
3. queue 管理
4. watchdog 恢复

这保证“worker A 正忙”不会阻塞“worker B 的新任务”。

补充约束（避免 lane 漂移）：

1. **worker session 独立**：每个 worker 的 session 空间彼此隔离；
2. **worker-project 独立 session**：同一 worker 在不同 project 下必须使用不同 root session；
3. **同项目多 worker 独立 session**：同一 project 下多个 worker 并行时，每个 worker 都有自己的 root session；
4. 不允许在任务进行中切换当前 lane 的 root session；
5. 发生 session 损坏时只能通过“关闭旧任务 + 重建新任务”迁移，禁止静默切换 lane。

### 5.2 ASCII 流程（并行派发）

```text
User -> SystemAgent
          |
          | analyze + update_plan
          v
   Dispatcher(select worker)
      |                 |
      | lane worker-A   | lane worker-B
      v                 v
  Project-X task    Project-Y task
    (busy)            (new dispatch)
      |                 |
      | continue        | start immediately
      v                 v
  Reviewer <-------- delivery by worker-B
```

---

## 6. 启动与恢复流程

启动顺序：

1. 仅启动 `system agent`；
2. 扫描未完成 project task（`active=true && status!=closed`）；
3. 对每个 project 读取 `assigneeWorkerId`；
4. 拉起对应 worker 并恢复其绑定 session；
5. 若 assignee 缺失或 worker 不可用，走重分配策略。

恢复策略：

1. 优先恢复原 worker（保证任务连续性）；
2. 原 worker 不可用（disabled/缺失/崩溃不可恢复）时，改派并记录 `reassignReason`。

session 选择策略（新增）：

1. 先定位 `(projectId, workerId)` 对应的 root session；
2. 不存在则创建新的 worker-project root session；
3. 同一 `(projectId, workerId)` 在 active 任务期间只允许一个 root session；
4. 不同 worker 即使属于同一 project，也必须使用不同 session。

---

## 7. 派发与调度策略

System 接到新任务后：

1. 若 project 有 active task 且已有 assignee：
   - assignee 空闲：更新任务（update task）给同 worker；
   - assignee 忙：可为**非阻塞子任务**选择其他空闲 worker 并行执行；
2. 若 project 无 active assignee：
   - 从池中挑选空闲 worker；
   - 无空闲且未达上限：新建/激活 worker；
   - 达上限：排队等待。

调度算法（默认）：

1. 优先同项目历史 worker（提高上下文连续性）；
2. 其次空闲 worker；
3. 再按负载最小选择；
4. 最后队列等待。

### 7.1 同项目多 worker 并行规则（新增）

同项目允许多个 worker 并行，但必须满足：

1. 子任务之间 `blockedBy` 不冲突（即非阻塞链路）；
2. 阻塞任务未完成时，依赖它的子任务进入 waiting；
3. 若某 worker因依赖阻塞而空闲，可“抢占式”领取该阻塞任务（当其未被其他 worker 执行或执行者不可用）；
4. 抢占后必须更新 `assigneeWorkerId` 与 `blockedBy` 关联图，保持可追踪。

---

## 8. 任务状态机（worker 责任制）

状态流：

`project.create -> dispatched -> accepted -> in_progress -> claiming_finished -> reviewed -> reported -> closed`

异步原则（新增，强制）：

1. 所有状态推进采用**事件驱动异步**，禁止以同步阻塞等待 reviewer；
2. worker 提交 `claiming_finished` 后立即释放执行槽位（worker 变为可分配）；
3. `claiming_finished` 仅表示“已提交待审”，不表示任务闭环完成；
4. reviewer 回传 `pass/reject` 后再异步触发后续状态推进：
   - `pass` -> `reviewed -> reported`
   - `reject` -> 回到 `in_progress`（保持原 taskId/revision 递增）。

字段要求（创建或更新时强校验）：

1. `blockedBy` 必填；无依赖必须显式写 `["none"]`；
2. `assigneeWorkerId` 必填（dispatched 后）；
3. `deliveryWorkerId` 在 `claiming_finished` 时必填；
4. `reviewerId` 在 review 阶段必填。
5. `reviewStatus` 在 `claiming_finished` 后必填：`pending|pass|reject`。

约束：

1. reviewer 只能 `pass/reject + evidence`，不能派发执行任务；
2. review 未通过直接打回 assignee worker，不通知 system 执行实现；
3. system 仅在 `reported/pending_approval` 阶段向用户汇总。
4. worker 在 `claiming_finished(reviewStatus=pending)` 时允许领取其它**非冲突任务**。

### 8.1 多任务数据模型补充（必须）

由于同项目允许并行子任务，不能只依赖单一 `projectTaskState`，必须同时维护：

1. `projectTaskState`：当前主任务（project-level summary）
2. `projectTaskRegistry[]`：子任务真源（每个子任务一条）

`projectTaskRegistry` 每项最小字段：

- `taskId`, `taskName`, `status`, `blockedBy[]`
- `assigneeWorkerId`, `deliveryWorkerId`, `reviewerId`
- `reviewStatus`, `reviewRequestId`
- `active`, `revision`, `leaseOwner`, `leaseExpireAt`
- `createdAt`, `updatedAt`, `summary`, `note`

并发控制：

1. 所有状态更新必须基于 `revision` 做 CAS（compare-and-set）；
2. 抢占 blocker 时必须先抢 `leaseOwner`（带 TTL），抢不到不得并发执行；
3. review 结果回写同样走 CAS，避免旧结果覆盖新进度。

worker 可用性计算（新增）：

1. worker 忙碌仅由“当前正在执行中的 execution lane”决定；
2. `claiming_finished + reviewStatus=pending` 不占用 busy 槽位；
3. worker 可同时存在：
   - A 任务：`claiming_finished/pending review`
   - B 任务：`in_progress`（正在执行）
4. 若 reviewer reject A，再将 A 放回该 worker 的待执行队列（或由 system 重分配）。

---

## 9. 项目管理与上下文更新

System 与 Worker 的项目上下文区分：

1. **System context**
   - `managedProjects[]`（监控项目清单）
   - `dispatchedTasks[]`（包含 assigneeWorkerId/status）
2. **Worker context**
   - `assignedTasks[]`
   - `currentSubTask`

更新机制：

1. 派发成功后同步写入 system + worker 的 task context；
2. 任务状态变化（accepted/in_progress/reviewed/closed）必须写盘；
3. 完成后归档到 `TASK_ARCHIVE.md`，并从活动上下文区清理。

### 9.1 统一工具原则：仅用 `update_plan` 管理项目视图（强制）

本设计中，project view 的唯一写入口是 `update_plan` 工具（不引入第二套任务写工具）。

`update_plan` 需要支持：

1. `list`：列出当前项目计划（可按 status/worker 过滤）；
2. `search`：按关键词/任务ID查找；
3. `upsert`：新增或更新计划项；
4. `status`：推进状态（accepted/in_progress/claiming_finished/...）；
5. `dependency`：更新 `blockedBy`。

访问控制（按 projectPath 过滤）：

1. **system agent**：可查看所有 project；
2. **worker/reviewer**：只能看到自己当前工作目录（projectPath）下的活动 project 与状态；
3. **worker 写权限隔离**：worker 只能更新自己名下的 plan（`assigneeWorkerId == self`）；
4. 可读但不可写他人 plan：同项目内可读取他人 plan 用于协同避冲突。

并发一致性：

1. 每条 plan 带 `revision`，写入必须 CAS；
2. CAS 失败自动刷新同项目 view 再重试；
3. 禁止跨 projectPath 写入（工具层硬拦截）。

> 结果：同项目双 worker 并行时，会形成两条独立的 plan 更新路径；二者可互看但不可互改，协同由共享 project view + 提示词约束完成。

### 9.2 `update_plan` 对齐 BD 的能力基线（新增，强制）

为了让 `update_plan` 成为项目管理唯一工具，能力必须对齐 BD 的核心闭环：

#### A. 数据模型（最小集合）

每条计划项（PlanItem）至少包含：

- `id`（稳定唯一，类似 issue id）
- `type`（`epic|task|subtask|review`）
- `title`
- `description`
- `status`（`open|in_progress|blocked|review_pending|done|closed`）
- `priority`（`P0..P3`）
- `projectPath`
- `assigneeWorkerId`
- `reporterAgentId`
- `blockedBy[]`（无依赖必须 `["none"]`）
- `dependsOn[]`（可选）
- `acceptanceCriteria[]`
- `evidence[]`（命令输出/日志路径/测试结果）
- `createdAt|updatedAt`
- `revision`（CAS）

#### B. 操作语义（tool contract）

`update_plan` 需要支持以下 action（统一入口）：

1. `create`
2. `update`
3. `list`
4. `search`
5. `claim`（认领）
6. `reassign`
7. `set_status`
8. `set_dependency`
9. `append_evidence`
10. `close`
11. `archive`

要求：

1. 所有写操作必须带 `expectedRevision`（CAS）；
2. CAS 冲突返回 `revision_conflict`，调用方必须先 `list/search` 刷新后重试；
3. 非法状态跳转返回 `invalid_transition`（由状态机硬校验）。

#### C. 状态机对齐（BD 风格）

允许路径（示例）：

- `open -> in_progress`
- `open -> blocked`
- `in_progress -> review_pending`
- `review_pending -> in_progress`（review reject）
- `review_pending -> done`（review pass）
- `done -> closed`

禁止：

- 跳过 `review_pending` 直接 `in_progress -> done`（除非显式 `skip_review=true` 且 system 批准）
- `closed` 回写（需 reopen action）

#### D. 依赖管理对齐

1. `blockedBy` 是执行阻塞依赖；
2. `dependsOn` 是逻辑/里程碑依赖（可不阻塞执行）；
3. `blockedBy` 未清除前，不可进入 `in_progress`（除 blocker 抢占规则外）。

#### E. 可观测性与证据

1. 每次状态变化必须写入 `plan_event`（append-only）；
2. `review_pending -> done` 必须附 evidence（至少一条）；
3. system 汇总给用户时，证据直接来自 `update_plan` 记录，不靠模型回忆。

#### F. 兼容策略（本设计）

1. 以 `update_plan` 为唯一管理工具；
2. 不再依赖独立 BD 命令作为运行时必需路径；
3. 如需导入历史，仅做一次性离线导入到 plan store，导入后由 `update_plan` 接管。

#### G. 权限策略（与 9.1 一致）

1. system：全项目读写；
2. worker：当前 project 可读，且仅可写自己 assignee 的项；
3. reviewer：可读项目计划，且仅可写 review 相关字段（`reviewStatus/evidence/reviewNote`），不可改执行 assignee。

session 拓扑（新增）：

1. `system session`：仅 system agent 使用；
2. `worker-project session`：`(workerId, projectId)` 一一对应；
3. `reviewer runtime session`：review 过程独立，不占用 worker-project session；
4. 任意状态回写必须带 `workerId + projectId + sessionId` 三元组，防止串写。

---

## 10. 错误处理与防死锁

1. **派发失败不丢任务**：进入 mailbox pending；
2. **busy 冲突不硬失败**：标记 `queued` 或 `skipped_target_busy`，等待下一轮；
3. **worker crash**：watchdog 检测后尝试恢复同 worker；
4. **恢复失败**：记录 `reassignReason` 并转派；
5. **禁止系统/worker 会话串线**：session 与 worker 强绑定，禁止跨 worker 切换。

补充：

6. **Reviewer 不可用降级**：reviewer runtime 不可用时，任务状态转 `review_pending` 并重试，不允许 system 代替 reviewer 做审查；
7. **阻塞图死锁检测**：周期性检测 `blockedBy` 环（A block B, B block A），发现后标记 `blocked_cycle` 并通知 system 汇总给用户。
8. **异步事件丢失保护**：review 回执事件必须可重放（幂等键：`reviewRequestId`），避免 worker 永久停留 `pending review`。

---

## 11. 与现有实现的兼容迁移

分阶段迁移：

### Phase 0：重置迁移策略（本次明确）

- 旧项目任务与旧 project-agent 兼容链路**不保留**；
- 升级时清理旧任务状态（active registry / legacy task state）；
- 新版本从全新 worker-pool 模型启动。
- 执行清理前输出快照备份：`~/.finger/backups/migration-<ts>/`（仅备份，不做兼容回放）。

### Phase 1：数据模型落地

- 增加 worker pool 配置；
- 增加 task state 字段（assignee/delivery/reviewer）。

### Phase 2：调度隔离

- queue/busy/active 从 agent 级切到 laneKey 级；
- `finger-project-agent` 单一目标迁移到具体 `finger-worker-*`。

### Phase 3：恢复与 review 闭环

- 启动恢复按 assigneeWorkerId；
- reviewer 直返 worker，system 只在 reported 阶段介入。

---

## 12. 验收标准（必须）

1. system 空闲 + worker-A 忙时，system 可成功派发任务给 worker-B 并立刻执行；
2. 重启后未完成 project 会恢复到原 assignee worker；
3. review reject 不触发 system 执行实现，仅回到 assignee worker；
4. 所有任务状态变更有持久化证据（task context + archive）；
5. 无 session 串线，无跨 worker 写入。
6. 同项目并行子任务在 `projectTaskRegistry` 中可追踪，且 `blockedBy` 关系正确；
7. 抢占 blocker 时不会重复执行（lease + CAS 验证通过）；
8. reviewer 双实例下同一交付只会被一个 reviewer 领取（无重复审查）。
9. 同一 project 下两个 worker 并行时，各自上下文与任务历史互不污染（session 完全隔离）。
10. worker 提交 review 后立即可领取新任务，不会因等待 reviewer 而阻塞。
11. reviewer 回传 reject 后，原任务可自动回流并继续执行（无人工唤醒也可恢复）。

---

## 13. 待 Review 风险点（本轮重点检查）

1. 同一项目是否允许多 worker 并行（默认建议：仅在显式子任务拆分后允许）；
2. worker 命名自动回写的并发写配置冲突（需要原子写）；
3. “阻塞任务抢占”是否可能引发重复执行（需要乐观锁/版本号）；
4. reviewer 双实例下的任务分配与去重策略；
5. reviewer 的退回策略是否需要“最多重试次数 + 人工升级”。

---

## 15. 心跳/周期任务与主任务并发规则（补充）

1. 目标 worker `busy` 时，heartbeat 只能 `skip`，不能 `queued` 干扰主任务；
2. mailbox-check 不得插队覆盖进行中的 project task；
3. heartbeat 仅做“恢复/巡检”，不做“新增业务任务派发”；
4. system 的业务派发优先级高于 heartbeat 文本注入。

---

## 16. 测试矩阵（实现前即锁定）

1. **并行派发**：worker-A 忙 + worker-B 空闲，新任务直达 worker-B；
2. **同项目并行**：两个非阻塞子任务并行执行；
3. **阻塞抢占**：worker-X 因 blocker 等待，worker-Y 空闲后成功抢占 blocker；
4. **CAS 冲突**：并发更新同 taskId，只有一个成功；
5. **review 去重**：双 reviewer 时同交付只被领取一次；
6. **重启恢复**：按 assigneeWorkerId 恢复，session 不串线；
7. **heartbeat 无干扰**：busy 时 heartbeat 不产生 queued 派发。
8. **review 异步释放**：worker 提交 review 后 busy=free，可立即执行新任务。
9. **review 回流**：review reject 事件到达后，任务自动回到可执行队列继续推进。

---

## 14. 自动命名策略（新增）

当 `workers[].name` 为空时：

1. 先读取现有 worker 名称集合；
2. 优先从 `nameCandidates` 中选取未被占用的名字；
3. 若候选集耗尽，则调用模型生成名字；
4. 每次生成后做冲突校验（大小写不敏感），冲突则重试；
5. 通过原子写（tmp+rename）回写配置，避免并发覆盖。
