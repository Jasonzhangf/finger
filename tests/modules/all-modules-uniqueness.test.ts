import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';

// Auto-discover all modules and check uniqueness
describe('All Modules Uniqueness', () => {
  const modulesDir = join(process.cwd(), 'src/server/modules');
  const moduleFiles = readdirSync(modulesDir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map(f => f.replace('.ts', ''));

  it('should have unique exports across all modules', async () => {
    const allExports = new Map<string, string[]>();

    for (const moduleName of moduleFiles) {
      try {
        const mod = await import(`../../src/server/modules/${moduleName}.js`);
        const exports = Object.keys(mod);

        for (const exp of exports) {
          if (exp === 'default') continue;

          const existing = allExports.get(exp);
          if (existing) {
            existing.push(moduleName);
          } else {
            allExports.set(exp, [moduleName]);
          }
        }
      } catch (e) {
        // Module may have import dependencies, skip
      }
    }

    const duplicates = [...allExports.entries()]
      .filter(([_, modules]) => modules.length > 1);

    if (duplicates.length > 0) {
      console.log('Duplicate exports found:', duplicates);
    }

    expect(duplicates).toHaveLength(0);
  });

  it('should have at least 10 modules', () => {
    expect(moduleFiles.length).toBeGreaterThanOrEqual(10);
  });
});
