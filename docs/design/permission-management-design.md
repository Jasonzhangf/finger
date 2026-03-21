# 权限管理系统设计文档

> Epic: finger-248
> 创建时间: 2026-03-21
> 参考: ~/code/codex 的 AskForApproval / ExecApproval / RequestPermissions 设计
> 状态: 设计中

## 一、Codex 权限管理参考分析

### 1.1 Codex 的权限体系（三个层面）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Codex 权限体系                                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  层面 1: 命令拦截 & 审批 (Command Interception)                                │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ shell.exec 调用                                                            │   │
│  │     │                                                                     │   │
│  │     ▼                                                                     │   │
│  │  exec_policy 检查                                                          │   │
│  │     │                                                                     │   │
│  │     ├─ sandbox 解析 (是否需要沙箱)                                        │   │
│  │     ├─ policy rule 匹配 (prefix rule 允许/拒绝)                      ��   │
│  │     └─ AskForApproval 判断:                                               │   │
│  │        ├─ Never → 直接拒绝执行                                                  │   │
│  │        ├─ OnFailure → 沙箱内执行，失败后升级到用户审批                     │   │
│  │        ├─ OnRequest → 发送 ExecApprovalRequestEvent 给 TUI/客户端              │   │
│  │        └─ UnlessTrusted → 只有只读命令自动通过                           │   │
│  │           │                                                              │   │
│  │           ▼                                                              │   │
│  │     TUI/客户端显示审批请求                                                     │   │
│  │     用户选择: Approved / Abort / ExecPolicyAmendment / Abort               │   │
│  │           │                                                              │   │
│  │           ▼                                                              │   │
│  │     继续执行或中断                                                          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  层面 2: 权限升级请求 (Permission Escalation)                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ 模型调用 request_permissions 工具                                                 │   │
│  │     │                                                                     │   │
│  │     ▼                                                                     │   │
│  │  session.request_permissions(call_id, {                                      │   │
│ │    permissions: { ... }   ← 请求额外的文件/网络权限                   │   │
│  │  })                                                                          │   │
│  │     │                                                                     │   │
│  │     ▼                                                                     │   │
│  │  发送 RequestPermissionsEvent 给 TUI/客户端                                │   │
│ │  TUI/客户端显示权限请求                                                     │   │
│  │  用户选择: 授予/拒绝/部分授予                                                   │   │
│ │     │                                                                     │   │
│ │     ▼                                                                     │   │
│  │  返回 RequestPermissionsResponse (scope: Turn 或 Session)                   │   │
│  │  授权后的权限自动应用到后续命令                                              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  层面 3: 文件系统沙箱 (Sandbox)                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ sandbox_policy:                                                          │   │
│  │   ├─ FileSystemSandboxPolicy (读写路径控制)                             │   │
│  │   ├─ NetworkSandboxPolicy (网络隔离)                                  │   │
│  │   └─ SpecialPath (Root/CWD/Tmpdir 等路径权限)                         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Codex 的 AskForApproval 枚举

```rust
pub enum AskForApproval {
    UnlessTrusted,  // 只自动通过已知的只读命令
    OnFailure,    // 沙箱内执行，失败后升级到用户
    OnRequest,    // 模型决定何时询问用户（默认）
    Reject(RejectConfig), // 细粒度拒绝控制
    Never,        // 从不询问，失败直接返回模型
}
```

### 1.3 Codex 的权限审批事件

```typescript
// 命令审批
ExecApprovalRequestEvent {
    call_id: string;
    command: string[];
    cwd: string;
    reason?: string;
    available_decisions: ["Approved", "ApprovedExecpolicyAmendment", "Abort"];
}

// 权限升级请求
RequestPermissionsArgs {
    reason?: string;
    permissions: PermissionProfile;  // 文件/网络权限
}

// 补丁审批
ApplyPatchApprovalRequestEvent {
    call_id: string;
    changes: HashMap<PathBuf, FileChange>;
    grant_root?: PathBuf;
}
```

### 1.4 Codex 的权限绑定

- **绑定到 Session/Turn**：通过 `PermissionGrantScope: Turn | Session` 控制
- **绑定到 Channel**：`TrustLevel: Trusted | Untrusted` 影响审批策略
- **动态升级**：模型通过 `request_permissions` 工具动态请求额外权限

---

## 二、Finger 当前实现

### 2.1 当前架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Finger 当前权限实现（有严重缺陷）                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ToolAuthorizationManager                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ 1. authorizationRequired 列表（agent.json 配置）                        │   │
│  │    ↓                                                                     │   │
│  │ 2. callTool 时检查 isToolRequired(name)                                │   │
│  │    ↓                                                                     │   │
│  │ 3. 如果需要授权:                                                          │   │
│  │    ├─ effectiveMode = options.authorizationMode                          │   │
│  │    │                ?? getAgentAuthorizationMode(agentId)  ← ❌ 这里断了   │   │
│  │    │                ?? 'prompt'                                             │   │
│    │    ├─ auto 模式: 自动签发一次性 token (60s TTL)                        │   │
│    │    ├─ prompt 模式: 抛错 "authorization token required"                    │   │
│    │    └─ deny 模式: 直接拒绝                                                │   │
│  │    ↓                                                                     │   │
│  │  verifyAndConsume(token, agentId, toolName)                            │   │
│  │    ↓                                                                     │   │
│  │  token 不匹配 → 抛错给模型                                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  问题:                                                                          │
│  1. authorizationMode 设置的是 orchestrator agent，                      │   │
│    但执行 shell.exec 的是 executor agent → 模式丢失                   │   │
│  2. prompt 模式下直接报错，模型无法知道需要授权                            │   │
│ 3. 没有提供授权工具给模型                                                  │   │
│ 4. 没有动态权限升级机制                                                      │
│ 5. 名称错误：这是权限管理，不是"授权模式"                                 │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 当前代码文件

| 文件 | 作用 | 问题 |
|------|------|------|
| `src/runtime/tool-authorization.ts` | Token 签发/验证 | 设计偏离，缺少工具返回给模型 |
| `src/runtime/tool-authorization-context.ts` | 按 agent 存储 mode | 绑定到 agent 而非渠道 |
| `src/runtime/runtime-facade.ts:314` | callTool 检查授权 | 授权模式丢失 |
| `~/.finger/runtime/agents/finger-executor/agent.json` | authorizationRequired 列表 | 配置概念正确但连线断裂 |
| `~/.finger/config/channels.json` | authorizationMode 配置 | 名称和绑定位置错误 |

---

## 三、对比总结

| 维度 | Codex | Finger (当前) | 应改为 |
|------|-------|-------------|---------|
| **核心理念** | 权限管理 + 审批流程 | Token 授权 | 权限管理 + 审批流程 |
| **工具调用** | 模型主动调用 `request_permissions` | 无工具，直接报错 | 新增权限工具 |
| **拒绝处理** | 返回结果给模型继续推理 | 直接 throw Error | 返回错误给模型 |
| **动态升级** | `request_permissions` 动态请求额外权限 | 无此能力 | 新增 |
| **权限粒度** | 文件/网络/沙箱/路径 | 只有工具级 on/off | 细化到文件/网络/路径 |
| **审批方式** | 事件通知 TUI/客户端 | 无 TUI 集成 | 集成 WebUI/QQBot |
| **绑定对象** | Session/Turn 级别 + Channel TrustLevel | Agent 级别（错误） | Channel/Session 级别 |
| **拒绝粒度** | 细粒度 RejectConfig | 无 | 细粒度拒绝控制 |
| **三种模式** | UnlessTrusted/OnFailure/OnRequest/Never/Reject | auto/prompt/deny（错误） | minimal/default/full |

---

## 四、设计方案（基于 Codex 参考优化）

### 4.1 权限模式定义

```typescript
type PermissionMode = 'minimal' | 'default' | 'full';

// minimal: 每次工具执行都需要用户确认（等同 Codex OnRequest）
// default: 白名单通过，黑名单拒绝，高危命令需要用户确认
// full: 所有命令默认可执行

### 4.1.1 拒绝颗粒度对齐 Codex

Codex 的 RejectConfig 提供细粒度拒绝控制，我们对齐如下：

| Codex RejectConfig | Finger 对齐字段 | 含义 |
|-------------------|----------------|------|
| `sandbox_approval` | `reject.sandboxEscalation` | 拒绝沙箱升级审批 |
| `rules` | `reject.policyRules` | 拒绝策略规则审批 |
| `skill_approval` | `reject.skillApproval` | 拒绝 skill 执行审批 |
| `request_permissions` | `reject.permissionRequest` | 拒绝权限升级请求 |
| `mcp_elicitations` | `reject.mcpElicitation` | 拒绝 MCP 征求 |

**行为要求**：
- 拒绝后必须返回结果给模型（不可静默失败）
- 返回中必须包含下一步建议（如重新授权 / 替代方案）
- 在 QQBot 中返回授权指令 `<##auth:xxxx##>`
```

### 4.2 权限工具（实现顺序第一步）

```typescript
// 1. 权限检查工具 - 模型在工具调用前主动调用
tool: "permission.check"
input: { toolName: "shell.exec", command: "rm -rf /tmp/test" }
output: {
  allowed: false,
  reason: "高危命令需要用户确认: rm -rf",
  requiresApproval: true,
  approvalId: "perm-xxx"
}

// 2. 权限授予工具 - 用户通过 QQBot `<##auth:xxxx##>` 或 WebUI 授权按钮
tool: "permission.grant"
input: { approvalId: "perm-xxx" }
output: { granted: true, scope: "turn" }

// 3. 权限拒绝工具 - 用户拒绝
tool: "permission.deny"
input: { approvalId: "perm-xxx" }
output: { granted: false, scope: "turn" }

// 4. 权限列表工具 - 查看当前权限状态
tool: "permission.list"
input: {}
output: { tools: [...], currentScope: "turn", granted: [...] }
```

### 4.3 QQBot 授权流程

```
System Agent 想执行高危命令
    │
    ▼
调用 permission.check
    │
    ▼
返回 { allowed: false, requiresApproval: true }
    │
    ▼
模型构造回复:
"需要您的授权才能执行此操作，请回复以下授权码：
<##auth:perm-xxx##>
授权后我将继续执行。"
    │
    ▼
发送给 QQBot 用户
    │
    ▼
用户复制 <##auth:perm-xxx##> 回复
    │
    ▼
解析用户回复，调用 permission.grant
    │
    ▼
继续执行命令
```

### 4.4 配置结构

```json
// channels.json
{
  "channels": [{
    "id": "qqbot",
    "permissionMode": "default",
    "highRiskCommands": ["rm -rf", "git reset --hard", "git checkout", "file.delete"],
    "blacklist": [],
    "whitelist": ["shell.exec", "exec_command", "view_image"]
  }]
}
```

### 4.5 拒绝后返回模型

```typescript
// 当前（错误）:
throw new Error('authorization token required for tool shell.exec');

// 应改为:
return {
  success: false,
  error: "需要用户授权才能执行此命令",
  requiresApproval: true,
  approvalId: "perm-xxx",
  suggestion: "调用 permission.check 检查或直接让用户回复授权码"
};
// → 模型收到后自动走授权流程
```

---

## 五、实施计划

### 顺序：授权工具 → 配置 → 连线

```
Step 1: 授权工具 (finger-248.1)
  - permission.check
  - permission.grant
  - permission.deny
  - permission.list
  → 独立可测试

Step 2: 配置 (finger-248.2)
  - PermissionMode 枚举: minimal/default/full
  - 高危命令列表
  - 白名单/黑名单
  - 渠道级权限配置
  → 不依赖工具

Step 3: 连线 (finger-248.3)
  - QQBot <##auth:xxx##> 解析
  - WebUI 授权弹窗
  - 拒绝后返回模型继续推理
  - callTool 集成
  → 集成测试

Step 4: 重构 (finger-248.4)
  - 删除 ToolAuthorizationManager
  - 重命名 authorizationMode → permissionMode
  - 移除 agent 级别绑定
  → 清理技术债
```
