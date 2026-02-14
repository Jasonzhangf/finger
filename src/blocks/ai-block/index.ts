import { BaseBlock, type BlockCapabilities } from '../../core/block.js';

interface AIRequest {
  sdk: 'iflow' | 'codex' | 'claude';
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

interface PromptTemplate {
  id: string;
  role: string;
  template: string;
}

export class AIBlock extends BaseBlock {
  readonly type = 'ai';
  readonly capabilities: BlockCapabilities = {
    functions: ['request', 'renderPrompt', 'registerTemplate', 'listTemplates'],
    cli: [
      { name: 'request', description: 'Send AI request', args: [] },
      { name: 'template', description: 'Manage prompt templates', args: [] }
    ],
    stateSchema: {
      requests: { type: 'number', readonly: true, description: 'Total AI requests' },
      templates: { type: 'number', readonly: true, description: 'Registered templates' }
    }
  };

  private templates: Map<string, PromptTemplate> = new Map();
  private requestCount = 0;

  constructor(id: string) {
    super(id, 'ai');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'request':
        return this.request(args as unknown as AIRequest);
      case 'renderPrompt':
        return this.renderPrompt(
          args.templateId as string,
          args.variables as Record<string, unknown>
        );
      case 'registerTemplate':
        return this.registerTemplate(args as unknown as PromptTemplate);
      case 'listTemplates':
        return this.listTemplates();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  async request(req: AIRequest): Promise<{ output: string; sdk: string }> {
    this.requestCount += 1;

    // Initial placeholder implementation.
    // In phase 2, this will be replaced with real SDK clients.
    const output = `[${req.sdk}] ${req.systemPrompt ? `[SYS:${req.systemPrompt}] ` : ''}${req.prompt}`;

    this.updateState({
      data: {
        requests: this.requestCount,
        lastSdk: req.sdk
      }
    });

    return { output, sdk: req.sdk };
  }

  registerTemplate(template: PromptTemplate): { registered: boolean } {
    this.templates.set(template.id, template);
    this.updateState({ data: { templates: this.templates.size } });
    return { registered: true };
  }

  renderPrompt(templateId: string, variables: Record<string, unknown>): { prompt: string } {
    const template = this.templates.get(templateId);
    if (!template) throw new Error(`Template ${templateId} not found`);

    let rendered = template.template;
    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.replaceAll(`{{${key}}}`, String(value));
    }

    return { prompt: rendered };
  }

  listTemplates(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }
}
