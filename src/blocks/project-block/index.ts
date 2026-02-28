import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { BaseBlock, type BlockCapabilities } from '../../core/block.js';
import type { Project } from '../../core/types.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface PickDirectoryResult {
  path: string | null;
  canceled: boolean;
  error?: string;
}

export class ProjectBlock extends BaseBlock {
  readonly type = 'project';
  readonly capabilities: BlockCapabilities = {
    functions: ['create', 'get', 'update', 'delete', 'list', 'sync', 'pick-directory'],
    cli: [
      { name: 'create', description: 'Create project', args: [] },
      { name: 'list', description: 'List projects', args: [] },
      { name: 'sync', description: 'Sync to bd', args: [] },
      { name: 'pick-directory', description: 'Pick project directory', args: [] }
    ],
    stateSchema: {
      projects: { type: 'number', readonly: true, description: 'Total projects' },
      lastSync: { type: 'string', readonly: true, description: 'Last bd sync time' }
    }
  };

  private projects: Map<string, Project> = new Map();

  constructor(id: string) {
    super(id, 'project');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'create':
        return this.create(args.name as string, args.description as string);
      case 'get':
        return this.get(args.projectId as string);
      case 'update':
        return this.update(args.projectId as string, args as Partial<Project>);
      case 'delete':
        return this.delete(args.projectId as string);
      case 'list':
        return this.list();
      case 'sync':
        return this.sync(args.projectId as string | undefined);
      case 'pick-directory':
        return this.pickDirectory(args.prompt as string | undefined);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  create(name: string, description = ''): Project {
    const id = `project-${Date.now()}`;
    const project: Project = {
      id,
      name,
      description,
      tasks: new Map(),
      createdAt: new Date(),
      updatedAt: new Date(),
      bdSynced: false
    };

    this.projects.set(id, project);
    this.updateState({ data: { projects: this.projects.size } });
    return project;
  }

  get(projectId: string): Project | undefined {
    return this.projects.get(projectId);
  }

  update(projectId: string, data: Partial<Project>): Project {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    Object.assign(project, data, { updatedAt: new Date() });
    project.bdSynced = false;
    return project;
  }

  delete(projectId: string): { deleted: boolean } {
    const deleted = this.projects.delete(projectId);
    this.updateState({ data: { projects: this.projects.size } });
    return { deleted };
  }

  list(): Project[] {
    return Array.from(this.projects.values());
  }

  async sync(projectId?: string): Promise<{ synced: number; errors: string[] }> {
    const errors: string[] = [];
    let synced = 0;

    const projectsToSync = projectId
      ? [this.projects.get(projectId)].filter(Boolean) as Project[]
      : Array.from(this.projects.values()).filter(p => !p.bdSynced);

    for (const project of projectsToSync) {
      try {
        await execAsync(`bd --no-db create "${project.name}" --type epic -p 0`);
        project.bdSynced = true;
        synced += 1;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`Project ${project.id}: ${errMsg}`);
      }
    }

    this.updateState({ data: { lastSync: new Date().toISOString() } });
    return { synced, errors };
  }

  async pickDirectory(prompt?: string): Promise<PickDirectoryResult> {
    const dialogPrompt = typeof prompt === 'string' && prompt.trim().length > 0
      ? prompt.trim()
      : 'Select project directory';
    if (process.platform === 'darwin') {
      return this.pickDirectoryDarwin(dialogPrompt);
    }
    if (process.platform === 'linux') {
      return this.pickDirectoryLinux(dialogPrompt);
    }
    if (process.platform === 'win32') {
      return this.pickDirectoryWindows(dialogPrompt);
    }
    return { path: null, canceled: false, error: `Unsupported platform: ${process.platform}` };
  }

  private async pickDirectoryDarwin(prompt: string): Promise<PickDirectoryResult> {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script]);
      const selected = stdout.trim();
      if (!selected) {
        return { path: null, canceled: true };
      }
      return { path: selected.replace(/\/+$/, ''), canceled: false };
    } catch (err) {
      return this.handlePickerError(err);
    }
  }

  private async pickDirectoryLinux(prompt: string): Promise<PickDirectoryResult> {
    try {
      const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', `--title=${prompt}`]);
      const selected = stdout.trim();
      if (!selected) {
        return { path: null, canceled: true };
      }
      return { path: selected, canceled: false };
    } catch (err) {
      const primary = this.handlePickerError(err);
      if (primary.canceled || primary.error?.includes('ENOENT')) {
        return primary;
      }
      return primary;
    }
  }

  private async pickDirectoryWindows(prompt: string): Promise<PickDirectoryResult> {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
      `$dialog.Description = ${JSON.stringify(prompt)};`,
      '$dialog.ShowNewFolderButton = $true;',
      'if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }',
      'Write-Output $dialog.SelectedPath;',
    ].join(' ');
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
      const selected = stdout.trim();
      if (!selected) {
        return { path: null, canceled: true };
      }
      return { path: selected, canceled: false };
    } catch (err) {
      return this.handlePickerError(err);
    }
  }

  private handlePickerError(err: unknown): PickDirectoryResult {
    const message = [
      err instanceof Error ? err.message : String(err),
      (err as { stderr?: string }).stderr ?? '',
      (err as { stdout?: string }).stdout ?? '',
    ].join(' ').trim();
    if (message.toLowerCase().includes('user canceled') || message.toLowerCase().includes('cancelled')) {
      return { path: null, canceled: true };
    }
    if (message.length === 0) {
      return { path: null, canceled: true };
    }
    return { path: null, canceled: false, error: message };
  }
}
