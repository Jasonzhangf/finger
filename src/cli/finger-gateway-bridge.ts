#!/usr/bin/env node
/**
 * Finger Gateway Bridge CLI
 * 
 * 独立的CLI工具，用于启动OpenClaw Gateway Bridge服务
 */

import { Command } from 'commander';
import { registerOpenClawGatewayBridgeCommand } from './openclaw-gateway-bridge.js';
import { getFingerAppVersion } from '../core/app-version.js';

const program = new Command();
program
  .name('finger-gateway-bridge')
  .description('Finger Gateway Bridge - Manage OpenClaw gateway bridge services')
  .version(getFingerAppVersion());

// 注册gateway-bridge命令
registerOpenClawGatewayBridgeCommand(program);

program.parse(process.argv);
