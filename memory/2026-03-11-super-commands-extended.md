# 超级命令扩展 - Project/Session 管理

**日期**: 2026-03-11
**状态**: 已完成

## 新增超级命令

### Project 管理
```
<##@project:list##>               # 列出所有项目（含会话数量）
<##@project:switch@/path/to/proj##>  # 切换项目
```

响应示例：
```json
{
  "type": "project_list",
  "projects": [
    { "path": "/Users/fanzhang/.finger/system", "sessionCount": 14 },
    { "path": "/Users/fanzhang/Documents/github/webauto", "sessionCount": 10 }
  ]
}
```

### Session 管理
```
<##@session:list##>               # 列出当前项目会话（含预览）
<##@session:switch@session-id##>  # 切换会话
```

响应示例：
```json
{
  "type": "session_list",
  "sessions": [
    {
      "id": "simple-test-002",
      "name": "finger-orchestrator",
      "lastAccessed": "2026-03-11T05:46:04.157Z",
      "preview": "Orchestrator: 你好！很高兴见到你..."
    }
  ]
}
```

## 完整超级命令列表

| 命令 | 功能 |
|------|------|
| `<##@system##>msg` | 切换到系统 agent |
| `<##@system:pwd=xxx##>msg` | 带密码切换系统 agent |
| `<##@agent##>msg` | 切换回业务 agent |
| `<##@project:list##>` | 列出项目 |
| `<##@project:switch@path##>` | 切换项目 |
| `<##@session:list##>` | 列出会话 |
| `<##@session:switch@id##>` | 切换会话 |

## 实现

- 解析器: `src/server/middleware/super-command-parser.ts`
- 路由处理: `src/server/routes/message.ts`
- 单元测试: `tests/unit/server/middleware/super-command-parser.test.ts`

## Tags

`super-command` `project-management` `session-management` `routing`

---

## 系统记忆设计 (待实现)

**需求**:
1. 独立的系统记忆存储，与普通 session 记忆隔离
2. 所有 agent 可写入和查询
3. 禁止删除和编辑（仅系统 agent 有权限）
4. 压缩后原始数据仍保留

**存储路径**: `~/.finger/system/memory.jsonl`

**权限模型**:
| Agent | 写入 | 查询 | 编辑 | 删除 |
|-------|------|------|------|------|
| 所有 agent | ✓ | ✓ | ✗ | ✗ |
| 系统 agent | ✓ | ✓ | ✓ | ✓ |

**工具**: `system_memory` 或复用 `context_ledger.memory` 带 `scope: system`

