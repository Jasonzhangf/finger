# Project Dream Memory Orchestration Design

## 1. 背景

当前 nightly 总结已经具备 digest-first 的基础能力，但产出仍偏“日报式文本”。
目标是把夜间整理升级为“可复用执行资产”：

1. 每个项目由对应 Project Agent 自治整理（不是 System Agent 自己总结所有项目）。
2. 产出写入项目独立 memory 空间，作为后续推理可直接复用的高信号资产。
3. System Agent 只做编排、分发、聚合结果。

---

## 2. 目标与非目标

### 2.1 目标

1. **项目隔离**：memory 按项目独立存储，互不污染。
2. **角色清晰**：System 编排；Project Agent 执行 dream；Reviewer 不参与 dream 实现。
3. **高信号沉淀**：产出规则/失败模式/交付模板，而非流水日志。
4. **可恢复**：dream 任务支持锁、重试与幂等。

### 2.2 非目标

1. 不在本阶段重做整个 context rebuild 算法。
2. 不在本阶段引入跨项目共享记忆融合。
3. 不改变现有业务任务状态机（project.create -> ... -> closed）。

---

## 3. 存储布局（唯一真源）

```text
~/.finger/memory/
  global/
    USER.md
    MEMORY.md
  projects/
    <project_slug>/
      MEMORY.md              # 项目记忆索引（入口）
      memories/*.md          # 项目主题记忆（规则/经验/失败模式/模板）
      logs/YYYY/MM/DD.md     # 可选：当日增量日志
      .dream.lock            # 并发锁
      .dream.state.json      # 游标/最近成功运行状态
```

约束：

1. Project Agent 只能读写自己项目的目录：`~/.finger/memory/projects/<project_slug>/...`。
2. 禁止跨项目读写 memory。
3. 全局用户画像与全局偏好继续保留在 `~/.finger/memory/global`（或兼容现有 `~/.finger/USER.md`、`~/.finger/MEMORY.md` 迁移策略）。

---

## 4. 项目识别与任务来源

System Agent 每个 nightly 窗口（00:00-07:59）构建 project dream 列表，来源：

1. **Monitored 项目**：来自 registry / orchestration 配置中的受监控项目。
2. **当日活跃项目**：当天 ledger 中出现有效执行事件（非 heartbeat/no-op）的项目。

去重规则：

- `project_slug` 去重；
- 同项目当窗口内最多触发 1 次 dream（除非手动强制）。

---

## 5. 调度与执行流程

```text
Nightly Scheduler
    -> System Agent (build project list)
        -> dispatch dream task (async, per project)
            -> Project Agent (project-scoped dream)
                -> write project memory assets
                -> submit dream result summary
        -> System Agent aggregate summary (optional)
```

### 5.1 System Agent 职责

1. 生成本轮 dream 任务列表。
2. 异步派发给对应 Project Agent（不阻塞串行等待）。
3. 记录派发状态与失败原因。
4. 收集每个项目 dream 结果并做聚合摘要。

### 5.2 Project Agent 职责

1. 获取项目锁 `.dream.lock`（失败则跳过并记录 busy）。
2. 执行 digest-first：
   - 先读 digest；
   - 过滤噪音（heartbeat/no-op/重复无状态变化）；
   - 只对高价值候选做原文扩张。
3. 产出并写入项目 memory（索引 + 主题文件）。
4. 回传结构化结果：
   - changed_files
   - rules_added
   - rules_updated
   - stale_removed
   - evidence_slots
5. 释放锁并更新 `.dream.state.json`。

---

## 6. 产出契约（不是日报）

Project dream 每次运行至少产出以下任一类高价值资产：

1. **Executable Rules（可执行规则）**
   - `if/when -> do` 规则
2. **Failure Guardrails（失败防呆）**
   - 已验证失败模式 + 避免策略
3. **Playbooks（流程模板）**
   - debug/development/review 可复用模板
4. **Delivery Patterns（交付模式）**
   - 证据格式、验收清单、最短验证路径

禁止仅写“今日做了什么”式描述作为唯一输出。

---

## 7. 错误处理与幂等

1. **锁冲突**：已有 dream 在跑 -> 标记 skipped(lock_busy)。
2. **模型失败**：重试（指数退避，最多 N 次）-> 仍失败则写失败事件并退出。
3. **部分写入失败**：
   - 写前生成临时文件；
   - 原子 rename 替换；
   - 失败回滚临时文件，保证 MEMORY.md 不损坏。
4. **幂等**：同一 `run_id + project_slug` 重入时不重复落盘同一 patch。

---

## 8. 可观测性

必须记录结构化日志字段：

- `dream_run_id`
- `project_slug`
- `source`（nightly/manual）
- `status`（started/skipped/completed/failed）
- `duration_ms`
- `changed_files_count`
- `high_signal_items_count`
- `noise_dropped_count`

System Agent 聚合视图：

- 本轮触发项目数
- 成功/失败/跳过统计
- 每项目产出摘要（最多 N 条）

---

## 9. 实施计划（Epic 分解）

1. `E1` 路由与调度：nightly project list + async dispatch。
2. `E2` Project dream runner：锁、digest-first、高价值扩张。
3. `E3` Project memory writer：目录布局、原子写入、索引更新。
4. `E4` 可观测与失败恢复：日志、状态、重试策略。
5. `E5` 验证：单测 + 集成 + 真实触发回放。

---

## 10. 验收标准

1. nightly 触发时，System Agent 仅编排，不直接生成全部项目梦境内容。
2. 每个项目 dream 结果落到 `~/.finger/memory/projects/<project_slug>/`。
3. 同项目并发 dream 被锁保护，不出现双写冲突。
4. 产出可归类到规则/防呆/模板/交付模式之一，不是纯日志。
5. 失败可恢复，且不会阻塞其他项目 dream。

