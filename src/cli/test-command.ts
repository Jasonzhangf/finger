import type { Command } from 'commander';

interface TestGroup {
  id: string;
  name: string;
  tests: Array<{ id: string; name: string; file: string; status: string; duration?: number; error?: string }>;
}

interface TestGroupsPayload {
  groups: TestGroup[];
  error?: string;
  message?: string;
}

interface TestRunResult {
  status: 'passed' | 'failed';
  duration?: number;
  error?: string;
}

function resolveBaseUrl(command: Command, fallback: string): string {
  const parent = command.parent;
  const opts = parent ? parent.opts() as { url?: string } : {};
  return opts.url || fallback;
}

function printGroups(groups: TestGroup[]): void {
  for (const group of groups) {
    console.log(`[${group.id}] ${group.name} (${group.tests.length})`);
  }
}

export function registerTestCommand(program: Command): void {
  const defaultDaemonUrl = process.env.FINGER_HUB_URL || process.env.FINGER_HTTP_URL || 'http://localhost:5521';
  const test = program.command('test').description('测试管理').option('-u, --url <url>', 'Daemon URL', defaultDaemonUrl);

  test
    .command('scan')
    .description('扫描测试分组')
    .option('-j, --json', 'JSON 输出')
    .action(async (options: { json?: boolean }) => {
      try {
        const baseUrl = resolveBaseUrl(test, defaultDaemonUrl);
        const res = await fetch(`${baseUrl}/api/v1/test/scan`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json() as TestGroupsPayload;

        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          printGroups(payload.groups || []);
        }
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[test scan] failed: ${message}`);
        process.exit(1);
      }
    });

  test
    .command('status')
    .description('查看测试状态')
    .option('-j, --json', 'JSON 输出')
    .action(async (options: { json?: boolean }) => {
      try {
        const baseUrl = resolveBaseUrl(test, defaultDaemonUrl);
        const res = await fetch(`${baseUrl}/api/v1/test/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json() as TestGroupsPayload;

        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          printGroups(payload.groups || []);
        }
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[test status] failed: ${message}`);
        process.exit(1);
      }
    });

  test
    .command('run-test')
    .description('运行单个测试用例')
    .argument('<testId>', '测试 ID（来自 scan 返回）')
    .option('-j, --json', 'JSON 输出')
    .action(async (testId: string, options: { json?: boolean }) => {
      try {
        const baseUrl = resolveBaseUrl(test, defaultDaemonUrl);
        const res = await fetch(`${baseUrl}/api/v1/test/run-test/${encodeURIComponent(testId)}`, {
          method: 'POST',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json() as TestRunResult;

        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(`[${payload.status}] duration=${payload.duration ?? 0}ms`);
          if (payload.error) {
            console.log(payload.error);
          }
        }
        process.exit(payload.status === 'passed' ? 0 : 1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[test run-test] failed: ${message}`);
        process.exit(1);
      }
    });

  test
    .command('run-group')
    .description('运行指定测试分组')
    .argument('<groupId>', '分组 ID（blocks/orchestration/agents/ui-*)')
    .option('-j, --json', 'JSON 输出')
    .action(async (groupId: string, options: { json?: boolean }) => {
      try {
        const baseUrl = resolveBaseUrl(test, defaultDaemonUrl);
        const res = await fetch(`${baseUrl}/api/v1/test/run-layer/${encodeURIComponent(groupId)}`, {
          method: 'POST',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json() as TestGroupsPayload;

        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          if (payload.error) {
            console.log(payload.error);
          }
          printGroups(payload.groups || []);
        }
        process.exit(payload.error ? 1 : 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[test run-group] failed: ${message}`);
        process.exit(1);
      }
    });

  test
    .command('run-all')
    .description('运行所有测试')
    .option('-j, --json', 'JSON 输出')
    .action(async (options: { json?: boolean }) => {
      try {
        const baseUrl = resolveBaseUrl(test, defaultDaemonUrl);
        const res = await fetch(`${baseUrl}/api/v1/test/run-all`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json() as TestGroupsPayload;

        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          if (payload.error) {
            console.log(payload.error);
          }
          printGroups(payload.groups || []);
        }
        process.exit(payload.error ? 1 : 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[test run-all] failed: ${message}`);
        process.exit(1);
      }
    });
}
