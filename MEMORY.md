# Finger 项目记忆

## 2026-03-11 OpenClaw 标准插件适配完成

### 已完成
1. **OpenClawRuntimeApi 适配器**
   - 支持 `plugin.register(api)` 标准方式
   - `registerChannel()` - 注册渠道插件
   - `registerGatewayMethod()` - 注册网关方法
   - `registerTool()` - 注册工具

2. **插件发现优先级**
   - Finger 插件目录 (`~/.finger/plugins`) 优先
   - OpenClaw 全局扩展 (`~/.openclaw/extensions`) 次之
   - 同名插件使用 finger 目录版本

3. **QQBot 插件已集成**
   - 符合标准 OpenClaw 插件格式
   - 已注册 `channel.qqbot` 工具
   - 配置: `appId=1903323793`

### 插件加载测试结果
```
Loaded plugins: 2

Plugin: openclaw-qqbot
  Name: OpenClaw QQ Bot
  Status: enabled
  Source: finger
  Tools: 1
  Tool IDs: [ 'channel.qqbot' ]

Plugin: weibo
  Name: weibo
  Status: enabled
  Source: openclaw
  Tools: 0
```

### 待完成
1. 实现 `callTool()` 实际执行逻辑
2. QQBot 消息收发测试
3. 渠道上下文与会话绑定

Tags: openclaw, plugin, qqbot, integration, channel
