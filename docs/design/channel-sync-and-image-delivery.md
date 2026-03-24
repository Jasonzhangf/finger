# Channel Sync & Image Delivery Design (System Agent)

## 目标

1. 图片收发不再硬编码为 QQ 语法；统一走 ChannelBridge 附件协议。
2. 支持接收端广播/同步配置：`qqbot only`、`openclaw-weixin only`、`webui only`、以及任意组合。
3. System Agent 提示词与能力文档明确心跳/mailbox/clock/系统配置/图片发送的统一操作入口。

---

## 1. 统一图片发送协议

### 1.1 工具入口
- 发送图片统一使用工具：`send_local_image`
- 工具输出为标准 `attachments: [{ type: "image", url, ... }]`

### 1.2 通道适配
- `OpenClawBridgeAdapter.sendMessage()` 负责把统一 `attachments` 交给具体 channel 插件：
  - 若 handler 支持 `sendMedia`，优先走 `sendMedia`
  - 否则退化为 `sendText`

### 1.3 兼容旧语法
- 对历史兼容输入 `<qqimg>...</qqimg>`，在 bridge 适配层做解析并转换为 `attachments`。
- 新流程禁止在提示词中依赖 `<qqimg>` 作为跨渠道发送协议。

---

## 2. 接收端同步（Broadcast/Fanout）

## 2.1 配置位置
- 文件：`~/.finger/config/channels.json`
- 节点：每个 channel 下 `options.sync`

```json
{
  "id": "qqbot",
  "channelId": "qqbot",
  "enabled": true,
  "options": {
    "sync": {
      "enabled": true,
      "targets": ["webui", "openclaw-weixin"],
      "targetOverrides": {
        "openclaw-weixin": "o9cq80_xxx@im.wechat"
      }
    }
  }
}
```

### 2.2 语义
- `enabled=false`：仅源渠道发送（如 `qqbot only`）
- `targets=[...]`：镜像到目标渠道（可填 `id` 或 `channelId`）
- `targetOverrides`：跨渠道目标地址映射（用于不同渠道 ID 体系不一致）

### 2.3 运行策略
- 主发送结果是唯一权威；镜像发送为 best-effort，不阻塞主发送成功返回。
- 跨渠道镜像不复用 `replyTo`（避免把 A 渠道线程 ID 误带到 B 渠道）。

---

## 3. System Agent 文档与提示词统一

System Agent 必须在以下入口统一理解并执行：
- 心跳：`heartbeat.*`
- 邮箱：`mailbox.*`
- 定时：`clock.*`
- 系统配置：`~/.finger/config/*.json`
- 图片发送：`send_local_image`

优先级：用户请求 > dispatch 结果 > 心跳任务。

---

## 4. OpenClaw Embedded Agent 冲突说明

当前“`No API key found for provider anthropic`”错误来自 **QClaw 自带 openclaw-gateway（~/.qclaw）** 的 embedded agent，而非 finger daemon。

处理原则：
1. 禁用/隔离 QClaw embedded agent 路径（避免与 finger 通道链路并行回复）。
2. finger 侧只保证 `~/.finger/config/channels.json` 声明的通道链路。
3. 如存在双 gateway 并存（`~/.openclaw` 与 `~/.qclaw`），以运维配置方式固定唯一入口。

