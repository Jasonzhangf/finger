import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { SkillsManager } from '../../../src/skills/skill-manager.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'finger-skills-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, dirName: string, name: string, description: string): void {
  const skillDir = path.join(root, dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8',
  );
}

describe('SkillsManager', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listSkillsSync reflects newly installed skills even after cache was already initialized', async () => {
    const root = makeTempDir();
    writeSkill(root, 'alpha', 'alpha', 'first skill');

    const manager = new SkillsManager();
    manager.stopWatching();
    (manager as any).skillsDir = root;

    const initial = await manager.listSkills();
    expect(initial.map((skill) => skill.name)).toEqual(['alpha']);

    writeSkill(root, 'beta', 'beta', 'second skill');

    const afterInstall = manager.listSkillsSync();
    expect(afterInstall.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('listSkillsScopedSync merges project-local skills and gives them precedence over global skills', async () => {
    const globalRoot = makeTempDir();
    const projectRoot = makeTempDir();
    const projectSkillsDir = path.join(projectRoot, '.codex', 'skills');

    writeSkill(globalRoot, 'alpha', 'alpha', 'global alpha');
    writeSkill(globalRoot, 'shared', 'shared', 'global shared');
    writeSkill(projectSkillsDir, 'shared-local', 'shared', 'project shared');
    writeSkill(projectSkillsDir, 'beta', 'beta', 'project beta');

    const manager = new SkillsManager();
    manager.stopWatching();
    (manager as any).skillsDir = globalRoot;

    await manager.listSkills();
    const merged = manager.listSkillsScopedSync({
      includeProjectSkills: true,
      projectPath: projectRoot,
      cwd: projectRoot,
    });

    const byName = new Map(merged.map((skill) => [skill.name, skill]));
    expect(byName.get('alpha')?.description).toBe('global alpha');
    expect(byName.get('beta')?.description).toBe('project beta');
    expect(byName.get('shared')?.description).toBe('project shared');
    expect(byName.get('shared')?.path).toContain(`${path.sep}.codex${path.sep}skills${path.sep}`);
  });
});
