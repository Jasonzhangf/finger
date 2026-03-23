---
title: "OpenClaw Integration Guide"
version: "1.0.0"
updated_at: "2026-03-23T03:12:00Z"
---

# OPENCLAW-INTEGRATION.md

## 目标

Finger 兼容标准 OpenClaw Gateway 插件安装流程，不修改插件代码，只做发现和配置。

## 插件安装真源

- **标准安装目录**: `~/.openclaw/extensions/`
- **安装方式**: 使用 OpenClaw 标准命令（如 `openclaw plugins install`）
- **Finger 原则**: 读取已安装插件并完成 channel 配置，不接管插件安装器

## Finger 配置真源

- `~/.finger/config/channels.json`：channel 配置（credentials、pushSettings、权限）
- `~/.finger/config/user-settings.json`：用户偏好与 provider 设置

## 标准接入流程（SOP）

1. 使用 OpenClaw 标准流程安装插件到 `~/.openclaw/extensions/`
2. 用 Finger 发现插件并读取 `openclaw.plugin.json`
3. 在 `~/.finger/config/channels.json` 写入 channel 配置
4. 重启 daemon：`npm run daemon:restart`
5. 验证日志与收发链路

## 重启命令

- 标准命令：`npm run daemon:restart`
- 目标：重新加载 channel 配置和 OpenClaw 插件映射

## 验证清单

- [ ] `~/.openclaw/extensions/` 下存在目标插件目录
- [ ] `~/.finger/config/channels.json` 含目标 channel 配置
- [ ] daemon 重启后日志中出现 channel register 成功
- [ ] 实际消息收发成功

