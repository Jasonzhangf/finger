# Finger 项目记忆

## 2026-03-11 双 Daemon 架构与标准化 Bridge 完成

### 已完成

1. **标准化 Channel Bridge 系统**
   - `src/bridges/types.ts` - 标准接口定义 (ChannelMessage, ChannelBridge, ChannelBridgeConfig)
   - `src/bridges/manager.ts` - 动态加载管理器 (支持异步 factory)
   - `src/bridges/openclaw-adapter.ts` - OpenClaw 插件适配器
   - OpenClaw 插件注册 channel 时自动注册为 BridgeModule

2. **CoreDaemon 集成**
   - 初始化 ChannelBridgeManager
   - 加载 `~/.finger/config/channels.json`
   - 消息处理闭环：channel-message → handleChannelMessage → hub.route → outputs
   - restart() 方法支持双 daemon 重启

3. **双 Daemon 架构**
   - `src/daemon/dual-daemon.ts` - 双进程互相监控
   - Daemon 1: port 9999/9998, Daemon 2: port 9997/9996
   - 5 秒健康检查间隔
   - 故障自动重启 (1 秒延迟)
   - CLI 命令:
     - `myfinger daemon start-dual`
     - `myfinger daemon stop-dual`
     - `myfinger daemon restart-dual`
     - `myfinger daemon status-dual --json`
     - `myfinger daemon enable-autostart` (launchd)
     - `myfinger daemon disable-autostart`

4. **配置文件**
   - `~/.finger/config/channels.json` - 渠道配置
   - `~/.finger/config/channels.json` 示例:
   ```json
   {
     "version": "v1",
     "channels": [
       {
         "id": "qqbot",
         "channelId": "qqbot",
         "enabled": true,
         "credentials": {
           "appId": "1903323793",
           "clientSecret": "woVyDF3dz72jCRRE",
           "accountId": "default"
         }
       }
     ]
   }
   ```

### 测试结果

- ✅ 双 daemon 启动成功 (PID 83083, 83104)
- ✅ Supervisor 运行 (PID 83013)
- ⏳ 故障恢复测试待进行
- ⏳ QQ 消息收发测试待进行

### 下一步

1. 测试故障恢复 (kill 一个 daemon 验证自动重启)
2. 测试真实 QQ 消息收发闭环
3. 启用开机自启

Tags: dual-daemon, bridge, openclaw, architecture, qqbot
