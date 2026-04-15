# Finger 多角色体系清理分析报告

## 分析时间
2026-04-15

## 发现总结

当前 finger 代码库中存在以下旧的多角色体系引用，需要统一清理为 **system agent + project agent** 两种角色。

## 旧角色列表

| 旧角色 | 含义 | 状态 |
|--------|------|------|
| orchestrator | 编排者 | 需清理 |
| executor | 执行者 | 需清理 |
| reviewer | 检查者 | 需清理 |
| searcher | 搜索者 | 需清理 |
| cli-base | CLI基础 | 需确认 |

## 代码中的引用（src/ 目录）

共发现 93 个文件包含旧角色引用：

### 关键文件
1. `src/blocks/orchestrator-block/index.ts` - orchestrator-block 实现
2. `src/blocks/command-hub/index.ts` - CommandExecutor 类
3. `src/blocks/command-hub/handlers/system-handler.ts`
4. `src/orchestration/orchestrator-fsm-v2.ts` - orchestrator FSM
5. `src/orchestration/` 目录下多个文件
6. `src/agents/prompts/orchestrator-prompts.ts`
7. `src/agents/chat-codex/agent-role-config.ts`
8. `src/agents/protocol/schema.ts`
9. `src/agents/finger-system-agent/` 目录下多个文件

### 需要处理的目录
- `src/blocks/orchestrator-block/` - 可能需要重命名或移除
- `src/orchestration/` - 目录名包含旧概念
- `src/agents/prompts/orchestrator-prompts.ts`

## 文档中的引用（docs/ 目录）

共发现多处引用，涉及以下文档：

### 高优先级（需要重写）
1. `docs/AGENT_ROLES.md` - 完整定义了 5 种旧角色
2. `docs/CONTEXT_PARTITION_RULES.md` - 第3点提到 Base agents
3. `docs/AGENT_JSON_CONFIG.md` - 角色推导逻辑

### 中优先级（需要更新）
1. `docs/design/chat-codex-prompt-contract.md` - 引用 dev-prompts 路径
2. `docs/design/agent-memory-management.md` - 大量 reviewer/orchestrator/executor 引用
3. `docs/design/context-rebuild-design.md` - executor 引用
4. `docs/design/multi-agent-prompt-collaboration-hardening-epic.md` - orchestrator/worker
5. `docs/design/permission-management-design.md` - orchestrator/executor
6. `docs/design/progress-monitor-architecture.md` - finger-reviewer-agent
7. `docs/design/structured-control-contract-and-rebuild.md` - hook.reviewer
8. `docs/design/superagent-session-governance-v1.md` - reviewer/executor/orchestrator
9. `docs/design/semantic-understanding-phase.md` - orchestrator_dispatch
10. `docs/design/project-agent-internal-collab-design.md` - system/reviewer

### 低优先级（参考性文档）
- `docs/architecture/orchestrator-phase-flow-with-resume.md`

## 空目录/无效文件

1. `src/agents/chat-codex/dev-prompts/` - 空目录（已确认）
2. `src/agents/roles/base.ts` - 空文件

## 建议的映射关系

| 旧角色 | 映射到新角色 | 说明 |
|--------|--------------|------|
| orchestrator | system agent | 系统级编排和调度 |
| executor | project agent | 项目级执行 |
| reviewer | system agent | 审核功能由 system agent 承担 |
| searcher | project agent | 搜索功能由 project agent 承担 |
| cli-base | 移除或合并 | 作为基础能力合并到 agent 基类 |

## 清理任务清单

### Phase 1: 文档重写（高优先级）
- [ ] 重写 `docs/AGENT_ROLES.md`
- [ ] 更新 `docs/CONTEXT_PARTITION_RULES.md`
- [ ] 更新 `docs/AGENT_JSON_CONFIG.md`
- [ ] 清理 `docs/design/chat-codex-prompt-contract.md`

### Phase 2: 设计文档更新（中优先级）
- [ ] 更新 `docs/design/agent-memory-management.md`
- [ ] 更新 `docs/design/permission-management-design.md`
- [ ] 更新 `docs/design/progress-monitor-architecture.md`
- [ ] 更新其他设计文档

### Phase 3: 代码重构（需要仔细测试）
- [ ] 重命名 `src/blocks/orchestrator-block/` → `src/blocks/scheduler-block/` 或类似
- [ ] 更新 `src/orchestration/` 目录下文件名和引用
- [ ] 更新 `src/agents/prompts/orchestrator-prompts.ts`
- [ ] 更新 `src/agents/chat-codex/agent-role-config.ts`
- [ ] 更新协议定义 `src/agents/protocol/schema.ts`
- [ ] 更新 system agent 相关文件
- [ ] 删除空目录 `src/agents/chat-codex/dev-prompts/`
- [ ] 删除空文件 `src/agents/roles/base.ts`

### Phase 4: 验证
- [ ] 运行 `grep -r "orchestrator\|executor\|reviewer\|searcher" src/ docs/ --include="*.ts" --include="*.md"` 确认无残留
- [ ] 运行测试确保功能正常
- [ ] 验证 dispatch 和 mailbox 功能

## 注意事项

1. **向后兼容性**：某些接口可能保留旧名称作为别名，需要添加注释说明
2. **功能完整性**：确保清理后 system agent 和 project agent 能覆盖所有原有功能
3. **测试覆盖**：清理后需要完整测试工作流

## 相关文件路径

- 文档目录：`/Volumes/extension/code/finger/docs/`
- 代码目录：`/Volumes/extension/code/finger/src/`
- 此分析文档：`/Volumes/extension/code/finger/docs/ROLE_CLEANUP_ANALYSIS.md`

