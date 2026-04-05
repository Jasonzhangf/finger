#!/usr/bin/env node
/**
 * Finger Config CLI
 *
 * 管理用户配置的CLI工具
 */

import { Command } from 'commander';
import {
  loadUserSettings,
  saveUserSettings,
  resetUserSettings,
  userSettingsExists,
  type UserSettings
} from '../core/user-settings.js';
import { syncUserSettingsToKernelConfig } from '../core/user-settings-sync.js';
import { logger } from '../core/logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';
import { getFingerAppVersion } from '../core/app-version.js';

const clog = createConsoleLikeLogger('FingerConfig');

const log = logger.module('ConfigCLI');

const program = new Command();
program
  .name('finger-config')
  .description('Manage user settings for Finger')
  .version(getFingerAppVersion());

// 获取配置
program.command('get [key]')
  .description('Get a configuration value (key or all if not specified)')
  .action((key) => {
    try {
      const settings = loadUserSettings();
      if (!key) {
        clog.log(JSON.stringify(settings, null, 2));
      } else {
        const value = getNestedValue(settings, key);
        if (value === undefined) {
          clog.error(`Key not found: ${key}`);
          process.exit(1);
        }
        clog.log(JSON.stringify(value, null, 2));
      }
    } catch (error) {
      clog.error(`Error loading settings: ${error}`);
      process.exit(1);
    }
  });

// 设置配置
program.command('set <key> <value>')
  .description('Set a configuration value (supports JSON paths like "aiProviders.default")')
  .action(async (key, value) => {
    try {
      const settings = loadUserSettings();
      const parsedValue = parseValue(value);

      const updated = setNestedValue(settings, key, parsedValue);
      updated.updated_at = new Date().toISOString();

      await saveUserSettings(updated);

      // 同步到 kernel config
      await syncUserSettingsToKernelConfig();

      clog.log(`✓ Updated ${key}: ${value}`);
    } catch (error) {
      clog.error(`Error updating settings: ${error}`);
      process.exit(1);
    }
  });

// 列出配置
program.command('list')
  .description('List all configuration values')
  .action(() => {
    try {
      const settings = loadUserSettings();
      clog.log(JSON.stringify(settings, null, 2));
    } catch (error) {
      clog.error(`Error loading settings: ${error}`);
      process.exit(1);
    }
  });

// 重置配置
program.command('reset')
  .description('Reset user settings to default')
  .option('-f, --force', 'Skip confirmation')
  .action(async (options) => {
    if (!options.force) {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question('Are you sure you want to reset all settings to default? (yes/no): ', resolve);
      });

      rl.close();

      if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
        clog.log('Reset cancelled');
        process.exit(0);
      }
    }

    try {
      const settings = await resetUserSettings();
      await syncUserSettingsToKernelConfig();
      clog.log('✓ Settings reset to default');
    } catch (error) {
      clog.error(`Error resetting settings: ${error}`);
      process.exit(1);
    }
  });

// 辅助函数：获取嵌套值
function getNestedValue(obj: any, key: string): any {
  return key.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
}

// 辅助函数：设置嵌套值
function setNestedValue(obj: any, key: string, value: any): any {
  const keys = key.split('.');
  const lastKey = keys.pop()!;
  const target = keys.reduce((o, k) => {
    if (o[k] === undefined) {
      o[k] = {};
    }
    return o[k];
  }, obj);
  target[lastKey] = value;
  return obj;
}

// 辅助函数：解析值
function parseValue(value: string): any {
  // 尝试解析为 JSON
  try {
    return JSON.parse(value);
  } catch {
    // 尝试解析为布尔值
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;

    // 尝试解析为数字
    const num = Number(value);
    if (!isNaN(num) && value !== '') return num;

    // 返回字符串
    return value;
  }
}

program.parse(process.argv);
