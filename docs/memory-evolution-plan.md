# Finger 记忆进化优化计划

> 基于 Hermes Agent 项目的进化机制，优化 Finger 项目的记忆治理与经验沉淀闭环。

## 一、现状分析

### 1.1 已具备的优势

- **行为宪法**: `AGENTS.md` 已规定三层架构、证据驱动、日志规范、会话 ownership、记忆原则
- **双记忆体系**:
  - `context-ledger-memory`: 事件/slot/timeline + compact + digest_incremental/backfill
  - `memory-tool`: MEMORY.md + semantic search + compact/reindex
- **生命周期管理**: 心跳机制、worker-owned session/memory
- **Skills 体系**: `SkillsManager` 已实现，支持 ~/.finger/skills/ 目录

### 1.2 当前问题

1. **双记忆并存但职责未统一**: ledger 与 MEMORY.md 分工边界模糊
2. **写入门槛缺失**: 低价值内容容易入 long-term，导致噪声膨胀
3. **缺乏强制进化闭环**: 任务结束缺乏自动复盘与沉淀机制
4. **compact 策略偏数量阈值**: 缺乏语义聚类与价值驱动压缩
5. **edit/delete 与 AGENTS 规则冲突**: AGENTS 写的是"只追加不删除"，但 tool 支持 edit/delete

## 二、目标架构

### 2.1 三层记忆分工（借鉴 Hermes）

| Layer | 存储载体 | 职责 | 特征 |
|-------|----------|------|------|
| Working Memory | context-ledger-memory | 短期会话推理 | slot/timeline，自动过期 |
| Durable Facts | MEMORY.md (Long-term) | 长期稳定事实 | 高价值、高复用、难遗忘 |
| Procedural Memory | skills/ + SKILL.md | 可复用流程 | 步骤化、模板化、可注入 |

### 2.2 进化闭环流程

```
任务开始 → 查询 memory + skills → 执行 → 采集证据 → 阶段复盘 → 分流沉淀 → 压缩索引 → 下轮预取
```

每一步必须有明确的触发条件和输出物。

## 三、具体改进项

### 3.1 P0（立即实施）

#### 3.1.1 统一记忆治理文档

- 文件: `docs/memory-governance.md`
- 内容:
  - ledger vs MEMORY.md vs skills 的职责边界
  - 写入门槛规则（价值驱动）
  - TTL 分级策略
  - 去重归并规则
  - 查询优先级

#### 3.1.2 任务结束复盘钩子

- 文件: `src/orchestration/memory-evolution-hook.ts`
- 功能:
  - 任务完成后自动触发复盘
  - 生成候选长期记忆 + candidate skills
  - 调用 compact/index
  - 可插拔，不强耦合主流程

#### 3.1.3 写入门槛校验

- 修改: `src/tools/internal/memory/memory-tool.ts`
- 功能:
  - insert 前校验：至少满足一条写入门槛
  - 低价值内容软拒绝（返回建议而非报错）
  - 支持用户强制写入（override flag）

写入门槛规则：
```
1) 30天后仍可能有用
2) 未来高概率复用
3) 若遗忘会导致重复错误/重复沟通成本
4) 用户明确要求记忆
```

### 3.2 P1（短期）

#### 3.2.1 去重与语义归并

- 在 insert 前做近似重复检测（title + tags + embedding similarity）
- 同义条目合并为一条，旧条目标记为 superseded

#### 3.2.2 Skills 目录模板化

- 文件: `~/.finger/skills/` 目录结构规范
- 每个 skill 必须有 `SKILL.md`（YAML frontmatter + markdown body）
- 支持 references/、templates/、scripts/ 子目录

#### 3.2.3 配置一致性修复

- 统一 edit/delete 行为与 AGENTS 规则
- 方案: 保留 edit/delete，但要求 system agent + 审计日志 + tombstone 不物理删

### 3.3 P2（中期）

#### 3.3.1 Compact 语义聚类

- 不只是列出前10条标题
- 按 type + tags + topic 做语义聚类
- 每个聚类生成一句话摘要
- 保留聚类代表作的完整内容

#### 3.3.2 记忆质量指标看板

指标定义：
- 命中率: 检索后被实际引用的比例
- 噪声率: 被判低价值条目的比例
- 重复率: 近似重复条目占比
- 压缩收益: token/条目下降比

#### 3.3.3 进化闭环编排层集成

- 把"复盘→沉淀→下轮预取"做成 orchestration block
- 作为 MessageHub 或 AgentRuntime 的标准 module

## 四、实施顺序

### Phase 1（本周）

1. ✅ 落盘本计划文档
2. 创建 `docs/memory-governance.md`
3. 创建 `src/orchestration/memory-evolution-hook.ts`（框架）
4. 在 memory-tool insert 加写入门槛校验

### Phase 2（下周）

1. 实现去重检测
2. 统一 edit/delete 与 AGENTS 规则
3. 完善 evolution-hook 的自动触发逻辑

### Phase 3（后续）

1. Compact 语义聚类
2. 质量指标看板
3. 编排层集成

## 五、验收标准

- [ ] 所有任务结束自动触发复盘钩子
- [ ] Long-term 区条目 90% 以上满足写入门槛
- [ ] 近似重复率 < 5%
- [ ] compact 后 token 下降 > 30%
- [ ] 用户不再重复纠正同一类问题

## 六、参考

- Hermes Agent: `~/.hermes/memory` + `~/.hermes/skills/` + `session_search`
- Hermes AGENTS.md: memory/skill/session_search 分工规则
- Finger AGENTS.md: 三层架构、会话 ownership、日志规范

---

> 本计划由 Hermes Agent 基于自身进化机制生成，用于指导 Finger 项目的记忆优化。