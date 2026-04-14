# Team Status Test Checklist

## 功能验证清单

### 1. 工具注册与可用性
- [ ] team.status 工具已注册到 InternalToolRegistry
- [ ] 所有 agent 可以调用 team.status 工具
- [ ] System Agent 可以看到全部 agents
- [ ] Project Agent 只能看到 scope 内的 agents

### 2. Scope 可见性规则
- [ ] System Agent（scope=system）：看到全部 agents
- [ ] Project Agent（scope=project）：只看到同 project 的 agents
- [ ] Project Agent 只能更新自己的 planSummary

### 3. 状态更新机制
- [ ] PeriodicCheckRunner 更新 runtimeStatus
- [ ] update_plan 工具更新 planSummary
- [ ] Agent unregister 清理 team.status

### 4. 持久化机制
- [ ] team.status store 使用 `~/.finger/system/team-status.json` 持久化
- [ ] 跨 session 状态共享正常工作
- [ ] 重启后状态恢复

### 5. 权限校验
- [ ] Project Agent 只能更新自己的 planSummary
- [ ] 不同 agentId 的 update 请求被拒绝

### 6. 边界情况
- [ ] 无 agent 时返回空列表
- [ ] 输入缺少 action 时返回错误
- [ ] update 缺少 planSummary 时返回错误

## 测试文件

- `tests/integration/team-status.test.ts`（已通过 6/6）

## 验证结果

| 检查项 | 状态 | 备注 |
|--------|------|------|
| 工具注册 | ✅ | `src/tools/internal/index.ts:128` |
| Scope 可见性 | ✅ | `filterTeamStatusByScope()` |
| PeriodicCheckRunner | ✅ | `src/agents/finger-system-agent/periodic-check.ts:138-147` |
| update_plan 集成 | ✅ | `src/tools/internal/codex-update-plan-tool.ts:232` |
| 持久化机制 | ✅ | `~/.finger/system/team-status.json` |
| 权限校验 | ✅ | `executeUpdate()` 中校验 agentId |
| 测试覆盖 | ✅ | 6 tests passed |

---

Created: 2026-04-14
