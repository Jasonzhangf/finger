# Finger 项目记忆

## 2026-03-11 OpenClaw 插件适配状态

### 当前实现方式
- QQBot 使用自定义桥接方式，非标准 OpenClaw 插件
- 消息收发已通：HTTP Server 监听 9997 端口
- 配置文件：`~/.finger/runtime/plugins/openclaw-qqbot.json`

### 待实现：标准 OpenClaw 插件支持
1. **OpenClawPluginApi 适配器**
   - 实现 `registerChannel()` 方法
   - 实现 `registerGatewayMethod()` 方法
   - 提供标准 API 给插件调用

2. **插件加载器**
   - 调用 `plugin.register(api)`
   - 管理插件生命周期
   - 支持动态安装/卸载

3. **ChannelPlugin 适配**
   - 统一消息格式转换
   - 支持多种渠道（QQ、微博等）

### 架构原则
- blocks 层：基础能力（OpenClawGateBlock）
- orchestration 层：编排逻辑（OpenClawAdapter）
- 严格三层架构，blocks 是唯一真源

Tags: openclaw, plugin, adapter, qqbot, integration
