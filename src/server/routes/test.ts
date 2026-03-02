import { Router, type Request, type Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';

const execAsync = promisify(exec);

const router = Router();

// Test layer configuration matching three-layer architecture
const TEST_LAYERS = {
  blocks: {
    name: 'Blocks 基础能力层',
    paths: ['tests/modules/', 'tests/unit/blocks/'],
  },
  orchestration: {
    name: 'Orchestration 编排层',
    paths: ['tests/orchestration/', 'tests/unit/orchestration/'],
  },
  agents: {
    name: 'Agents 业务层',
    paths: ['tests/agents/', 'tests/unit/agents/'],
  },
} as const;

type LayerKey = keyof typeof TEST_LAYERS;

interface TestCase {
  id: string;
  name: string;
  file: string;
  layer: LayerKey;
  status: 'pending' | 'running' | 'passed' | 'failed';
  duration?: number;
  error?: string;
}

interface TestGroup {
  layer: LayerKey;
  tests: TestCase[];
}

// Cache for scanned tests and results
let scannedTests: TestGroup[] | null = null;
let lastTestResults = new Map<string, { status: 'passed' | 'failed'; duration?: number; error?: string }>();

// Scan tests from filesystem
function scanTestsFromFS(): TestGroup[] {
  const groups: TestGroup[] = [];
  const cwd = process.cwd();

  for (const [layer, config] of Object.entries(TEST_LAYERS)) {
    const tests: TestCase[] = [];

    for (const testPath of config.paths) {
      const fullPath = join(cwd, testPath);
      if (!existsSync(fullPath)) continue;

      const files = readdirSync(fullPath).filter(f => f.endsWith('.test.ts') || f.endsWith('.test.tsx'));

      for (const file of files) {
        const testId = `${layer}:${testPath}:${file}`;
        const lastResult = lastTestResults.get(testId);

        tests.push({
          id: testId,
          name: file.replace(/\.(test\.)?(ts|tsx)$/, '').replace(/-/g, ' '),
          file: relative(cwd, join(fullPath, file)),
          layer: layer as LayerKey,
          status: lastResult?.status || 'pending',
          duration: lastResult?.duration,
          error: lastResult?.error,
        });
      }
    }

    groups.push({
      layer: layer as LayerKey,
      tests,
    });
  }

  scannedTests = groups;
  return groups;
}

// Scan endpoint - discover all tests
router.get('/scan', (_req: Request, res: Response) => {
  const groups = scanTestsFromFS();
  res.json({ groups });
});

// Run single test
router.post('/run-test/:testId', async (req: Request, res: Response) => {
  const testId = req.params.testId as string;

  if (!scannedTests) {
    scanTestsFromFS();
  }

  let testFile: string | null = null;
  for (const group of scannedTests || []) {
    const test = group.tests.find(t => t.id === testId);
    if (test) {
      testFile = test.file;
      break;
    }
  }

  if (!testFile) {
    return res.status(404).json({ error: 'Test not found' });
  }

  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(`npm test -- --run "${testFile}"`, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 10,
    });
    const duration = Date.now() - start;

    const output = stdout || stderr;
    const passed = output.includes('passed') || !output.includes('failed');

    const result = {
      status: passed ? 'passed' as const : 'failed' as const,
      duration,
      error: passed ? undefined : output.slice(-500),
    };

    lastTestResults.set(testId, result);
    res.json(result);
  } catch (error) {
    const duration = Date.now() - start || 0;
    const result = {
      status: 'failed' as const,
      duration,
      error: error instanceof Error ? error.message : 'Test failed',
    };
    lastTestResults.set(testId, result);
    res.json(result);
  }
});

// Run all tests in a layer
router.post('/run-layer/:layer', async (req: Request, res: Response) => {
  const layer = req.params.layer as string;

  if (!TEST_LAYERS[layer as LayerKey]) {
    return res.status(400).json({ error: 'Invalid layer' });
  }

  const layerConfig = TEST_LAYERS[layer as LayerKey];

  try {
    const paths = layerConfig.paths.filter(p => existsSync(join(process.cwd(), p)));
    if (paths.length === 0) {
      return res.json({ groups: scanTestsFromFS(), message: 'No test paths found for this layer' });
    }

    const testPattern = paths.map(p => `${p}**/*.test.ts`).join(' ');
    const cmd = `npm test -- --run ${testPattern}`;

    await execAsync(cmd, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 10,
    });

    const groups = scanTestsFromFS();
    res.json({ groups });
  } catch (error) {
    const groups = scanTestsFromFS();
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.json({ groups, error: errorMsg });
  }
});

// Run all tests
router.post('/run-all', async (_req: Request, res: Response) => {
  try {
    await execAsync('npm test -- --run', {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 20,
      timeout: 120000,
    });

    const groups = scanTestsFromFS();
    res.json({ groups });
  } catch (error) {
    const groups = scanTestsFromFS();
    const errorMsg = error instanceof Error ? error.message : String(error);
    res.json({ groups, error: errorMsg });
  }
});

// Get test status
router.get('/status', (_req: Request, res: Response) => {
  if (scannedTests) {
    return res.json({ groups: scannedTests });
  }

  const groups = scanTestsFromFS();
  res.json({ groups });
});

export default router;

export function registerTestRoutes(app: import('express').Express): void {
  app.use('/api/v1/test', router);
}
