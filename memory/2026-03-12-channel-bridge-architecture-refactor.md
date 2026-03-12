# ChannelBridge 架构改造方案

Tags: channel-bridge, messagehub, architecture, refactor, phases

## 背景

### 当前架构问题
1. **分层破坏**: ChannelBridge 直接调用 `dispatchTaskToAgent`，绕过 MessageHub / mailbox
2. **时序与依赖兜底**: `globalThis.__pendingChannelHandlers` + 动态 require
3. **接口不封闭**: `callbacks_` 直接暴露内部回调

### 现有通道状态
- QQBot: 直连 `ChannelBridge → dispatchTaskToAgent` (绕过 MessageHub)
- WebUI: 走 `/api/messages` → `mailbox.createMessage` → `hub.route`
- CLI: 与 WebUI 类似

**结论**: 多通道链路不一致，路由逻辑分散，扩展性差

---

## 改造目标

### 架构原则（强制）
1. **所有通道消息必须进入 mailbox**
2. **MessageHub 是唯一调度入口**
3. **ChannelBridge 只做 IO，不做 routing**
4. **OpenClaw 只负责通道插件协议，不参与系统路由**

---

## 分阶段改造方案

### Phase 1: 构建新层次（不改接线）

**目标**: 搭建新接口层，保持系统运行不变

#### 新增模块
1. **ChannelBridge → MessageHub Input 模块**
   - 文件: `src/bridges/channel-bridge-input.ts`
   - 功能: 将 ChannelBridge.onMessage 转换为 MessageHub.registerInput

2. **MessageHub → ChannelBridge Output 模块**
   - 文件: `src/bridges/channel-bridge-output.ts`
   - 功能: MessageHub 输出路由到 ChannelBridge.sendMessage

3. **统一消息 Envelope 规范**
   - 定义: `ChannelMessageEnvelope` 接口
   - 字段: `msg_id`, `channel`, `sender`, `replyTo`, `metadata`

#### 保持不变
- 现有 QQ 直连路径保留
- 不启用新通路

---

### Phase 2: 测试完备（仍不切线）

#### 单测清单
- [ ] `channel-bridge-input.ts`: 消息转换正确
- [ ] `channel-bridge-output.ts`: 输出路由正确
- [ ] `Envelope`: msg_id / replyTo / metadata 正确传递
- [ ] MessageHub: 无路由时进 queue
- [ ] MessageHub: routeToOutput 完整

#### 集成测试
- [ ] `Mailbox → MessageHub → Agent → Reply → Output`
- [ ] QQ / WebUI / CLI 三通道入站结构一致

#### 关键断言
- `replyTo` 必须使用 `metadata.messageId`
- `msg_id` 永远等于原始 MessageSid
- 无路由时消息进 queue
- Output 回调完整走通

---

### Phase 3: 灰度接线切换（最后一步）

#### 配置开关
```bash
CHANNEL_BRIDGE_USE_HUB=true  # 默认 false
```

#### 切换模式
1. **Shadow Mode**: 双发，仅观察（hub 输出不回 channel）
2. **Full Mode**: 正式接线，只走 hub

#### 回滚策略
- toggle 回 false → 立即恢复旧链路

---

## Hack 清理计划（Phase 1/2）

以下代码需要重构（不影响接线）：

| Hack | 位置 | 改进方案 |
|------|------|----------|
| `globalThis.__pendingChannelHandlers` | `openclaw-api-adapter.ts` | 使用显式注册 registry |
| 动态 `require` | `openclaw-api-adapter.ts` | 依赖注入 |
| `callbacks_` 暴露 | `openclaw-adapter.ts` | 封装为方法调用 |

---

## 时间线

| 阶段 | 预计耗时 | 风险等级 |
|------|----------|----------|
| Phase 1 | 2-3 天 | 低（不动接线）|
| Phase 2 | 2 天 | 低 |
| Phase 3 | 1 天 | 中（切换）|

---

## 验收标准

### Phase 1 完成标准
- [ ] 新接口层代码存在且编译通过
- [ ] 不影响现有 QQ/WebUI 功能
- [ ] 代码 review 通过

### Phase 2 完成标准
- [ ] 单测覆盖率 > 80%
- [ ] 集成测试通过
- [ ] 文档更新

### Phase 3 完成标准
- [ ] Shadow mode 验证通过
- [ ] Full mode 切换成功
- [ ] 回滚测试通过
- [ ] QQ 消息收发正常

---

## 决策记录

- **2026-03-12**: 用户确认采用"分阶段改造"方案
- **原则**: 先改造层次 → 测试完备 → 最后接线
- **目标**: 统一所有通道到 MessageHub，消除打洞


## Phase 1 & 2 完成记录

### 2026-03-12 完成内容

#### 新增模块
- `src/bridges/envelope.ts` - 统一消息封套规范
- `src/bridges/channel-bridge-input.ts` - ChannelBridge → MessageHub Input
- `src/bridges/channel-bridge-output.ts` - MessageHub → ChannelBridge Output

#### 测试覆盖
| 测试文件 | 测试数 | 状态 |
|---------|--------|------|
| `tests/unit/bridges/envelope.test.ts` | 13 | ✅ 通过 |
| `tests/unit/bridges/channel-bridge-input.test.ts` | 7 | ✅ 通过 |
| `tests/unit/bridges/channel-bridge-output.test.ts` | 7 | ✅ 通过 |
| `tests/integration/bridges/channel-bridge-hub-integration.test.ts` | 4 | ✅ 通过 |
| **总计** | **31** | ✅ **全部通过** |

#### 关键验证
- ✅ `messageId` 必须等于原始消息 ID
- ✅ `id` 必须使用原始消息 ID
- ✅ `metadata.messageId` 必须存在
- ✅ `replyTo` 必须等于 `metadata.messageId`
- ✅ 群消息使用 `group:` 前缀
- ✅ 多通道隔离正确

### 下一步：Phase 3
- 添加配置开关 `CHANNEL_BRIDGE_USE_HUB`
- 灰度接线切换

## Phase 3 完成记录

### 2026-03-12 动态接入架构实现

#### 核心特性
- **无限通道支持**: 只需配置权限，自动接入 MessageHub
- **动态注册**: 通道启动时自动注册到 MessageHub
- **单开关控制**: `FINGER_CHANNEL_BRIDGE_USE_HUB` 环境变量切换路由模式
- **零代码扩展**: 新通道只需配置 `~/.finger/config/channels.json`

#### 架构优势
1. **真正可扩展**: 无需修改代码即可添加新通道
2. **统一路由**: 所有通道统一通过 MessageHub
3. **灰度切换**: 支持新旧模式动态切换
4. **回滚简单**: 环境变量控制，立即生效

#### 实现细节
- 配置开关: `FINGER_CHANNEL_BRIDGE_USE_HUB` (默认 false)
- 消息路由: `channel.<channelId>` 模式自动匹配
- 自动注册: `channel-bridge-hub-route` 路由处理所有通道
- 动态适配: 新通道自动接入，无需重启

#### 使用方法
\`\`\`bash
# 启用 MessageHub 模式（新架构）
export FINGER_CHANNEL_BRIDGE_USE_HUB=true

# 使用旧模式（兼容）
export FINGER_CHANNEL_BRIDGE_USE_HUB=false  # 或不设置
\`\`\`

Tags: channel-bridge, messagehub, dynamic, unlimited-channels, auto-registration, 2026-03-12

## 测试指南

### 1. 默认模式测试（旧路径）
```bash
# 不设置环境变量，使用旧路径
myfinger daemon restart

# 发送 QQ 消息测试
# 日志应显示: "[Server] Using direct dispatch (legacy mode)"
```

### 2. MessageHub 模式测试（新路径）
```bash
# 启用 MessageHub 模式
export FINGER_CHANNEL_BRIDGE_USE_HUB=true
myfinger daemon restart

# 发送 QQ 消息测试
# 日志应显示: "[Server] Routing via MessageHub (dynamic mode)"
# 日志应显示: "[Server] Processing channel message via MessageHub"
```

### 3. 验证要点
- ✅ 消息正常接收
- ✅ Agent 正常处理
- ✅ 回复正常发送
- ✅ replyTo 使用原始 messageId
- ✅ 支持任意通道（qqbot/webui/其他）

### 4. 回滚方法
```bash
# 立即回滚到旧模式
export FINGER_CHANNEL_BRIDGE_USE_HUB=false
myfinger daemon restart
```

## 架构对比

### 旧架构（默认）
```
ChannelBridge → dispatchTaskToAgent → Agent → sendReply
```

### 新架构（MessageHub 模式）
```
ChannelBridge → MessageHub → Route Handler → Agent → MessageHub → sendReply
```

### 优势
- 统一消息路由
- 支持无限通道
- 动态注册
- 可观测性强
