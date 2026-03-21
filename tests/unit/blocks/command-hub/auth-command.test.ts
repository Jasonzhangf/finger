/**
 * CommandHub Auth/Permission Command Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseCommands } from '../../../../src/blocks/command-hub/parser.js';
import { CommandType } from '../../../../src/blocks/command-hub/types.js';
import { initCommandHub } from '../../../../src/blocks/command-hub/index.js';
import { permissionState } from '../../../../src/tools/internal/permission-tools.js';

describe('CommandHub auth command parsing', () => {
  it('should parse <##auth:grant@approvalId##>', () => {
    const input = '<##auth:grant@test-approval-123##>';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.AUTH_GRANT);
    expect(result.commands[0].params.approvalId).toBe('test-approval-123');
  });

  it('should parse <##auth:deny@approvalId##>', () => {
    const input = '<##auth:deny@test-approval-456##>';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.AUTH_DENY);
    expect(result.commands[0].params.approvalId).toBe('test-approval-456');
  });

  it('should parse <##auth:status##>', () => {
    const input = '<##auth:status##>';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.AUTH_STATUS);
  });

  it('should parse simple <##auth:approvalId##> as grant', () => {
    const input = '<##auth:some-id-here##>';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.AUTH_GRANT);
    expect(result.commands[0].params.approvalId).toBe('some-id-here');
  });

  it('should strip auth command from effective content', () => {
    const input = '请授权 <##auth:grant@abc123##> 谢谢';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.effectiveContent).toContain('请授权');
    expect(result.effectiveContent).not.toContain('<##auth:grant@abc123##>');
  });

  it('should not break existing @-prefixed commands', () => {
    const input = '<##@system:restart##>';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.SYSTEM_RESTART);
  });

  it('should not match <##help##> as auth command', () => {
    const input = '<##help##>';
    const result = parseCommands(input);
    // help is a bare command (no action/param), should be CMD_LIST
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.CMD_LIST);
  });
});

describe('CommandHub auth command execution', () => {
  let hub: ReturnType<typeof initCommandHub>;

  beforeEach(() => {
    permissionState.reset();
    hub = initCommandHub();
  });

  it('should execute auth:status and return pending list', async () => {
    const cmd = parseCommands('<##auth:status##>').commands[0];
    const result = await hub.execute(cmd, { channelId: 'test-channel' });
    expect(result.success).toBe(true);
  });

  it('should return error for auth:grant without approvalId', async () => {
    const cmd = parseCommands('<##auth:grant##>').commands[0];
    const result = await hub.execute(cmd, { channelId: 'test-channel' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('MISSING_APPROVAL_ID');
  });

  it('should return error for auth:deny without approvalId', async () => {
    const cmd = parseCommands('<##auth:deny##>').commands[0];
    const result = await hub.execute(cmd, { channelId: 'test-channel' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('MISSING_APPROVAL_ID');
  });

  it('should deny non-existent approvalId', async () => {
    const cmd = parseCommands('<##auth:grant@nonexistent##>').commands[0];
    const result = await hub.execute(cmd, { channelId: 'test-channel' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('授权失败');
  });

  it('should grant and deny existing approval', async () => {
    // Create an approval request via permission.check
    const checkResult = permissionState.createApprovalRequest(
      'shell.exec',
      '需要执行命令',
      'high',
      'rm -rf /tmp/test'
    );
    expect(checkResult.status).toBe('pending');
    expect(checkResult.id).toBeTruthy();

    // Grant it via command hub
    const grantCmd = parseCommands(`<##auth:grant@${checkResult.id}##>`).commands[0];
    const grantResult = await hub.execute(grantCmd, { channelId: 'test-channel' });
    expect(grantResult.success).toBe(true);
    expect(grantResult.output).toContain('授权成功');
  });

  it('should handle auth:deny for existing approval', async () => {
    const request = permissionState.createApprovalRequest(
      'shell.exec',
      '需要执行命令',
      'high',
      'git reset --hard'
    );

    const denyCmd = parseCommands(`<##auth:deny@${request.id}##>`).commands[0];
    const denyResult = await hub.execute(denyCmd, { channelId: 'test-channel' });
    expect(denyResult.success).toBe(true);
    expect(denyResult.output).toContain('已拒绝');
  });
});
