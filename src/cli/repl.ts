/**
 * REPL Mode - Interactive Command Line Interface
 * 
 * Features:
 * - Real-time event display
 * - User decision prompts
 * - Command history
 * - Workflow management
 */

import * as readline from 'readline';
import { FingerClient, type RuntimeEvent, type UserDecision } from '../client/finger-client.js';
import { printEvent, printWorkflowStatus, printError, printSuccess, setOutputFormat } from './output.js';
import { ExitCode } from './errors.js';

export interface REPLConfig {
  httpUrl?: string;
  wsUrl?: string;
  prompt?: string;
}

export class FingerREPL {
  private rl: readline.Interface;
  private client: FingerClient;
  private currentWorkflowId: string | null = null;
  private currentSessionId: string;
  private prompt: string;
  private isRunning = false;
  private commandHistory: string[] = [];
  private historyIndex = -1;

  constructor(config: REPLConfig = {}) {
    this.client = new FingerClient({
      httpUrl: config.httpUrl,
      wsUrl: config.wsUrl,
    });
    this.currentSessionId = `session-${Date.now()}`;
    this.prompt = config.prompt || '> ';
    
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      history: this.commandHistory,
      historySize: 100,
    });
  }

  /**
   * Start REPL
   */
  async start(): Promise<void> {
    console.log('Finger REPL v1.0.0');
    console.log('Type /help for available commands\n');

    // Connect to daemon
    try {
      console.log('Connecting to daemon...');
      await this.client.connect();
      console.log('Connected ✓\n');
    } catch (error) {
      printError('Failed to connect to daemon. Is it running?', error);
      console.log('Start daemon with: finger daemon start\n');
      process.exit(ExitCode.DAEMON_NOT_RUNNING);
    }

    // Subscribe to all events
    this.client.subscribeAll((event) => this.handleEvent(event));

    // Set up decision handler
    this.client.onDecision((decision) => this.handleDecision(decision));

    // Monitor connection state
    this.client.onStateChange((state) => {
      if (state === 'disconnected') {
        console.log('\n⚠️  Connection lost. Reconnecting...');
      } else if (state === 'connected') {
        console.log('✓ Reconnected');
        this.promptUser();
      }
    });

    this.isRunning = true;
    this.promptUser();
  }

  /**
   * Stop REPL
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this.client.disconnect();
    this.rl.close();
    console.log('\nGoodbye!');
  }

  /**
   * Prompt user for input
   */
  private promptUser(): void {
    if (!this.isRunning) return;
    this.rl.question(this.getPromptText(), async (line) => {
      await this.handleInput(line.trim());
      this.promptUser();
    });
  }

  /**
   * Get prompt text with workflow status
   */
  private getPromptText(): string {
    if (this.currentWorkflowId) {
      return `[${this.currentWorkflowId.slice(0, 8)}] ${this.prompt}`;
    }
    return this.prompt;
  }

  /**
   * Handle user input
   */
  private async handleInput(line: string): Promise<void> {
    if (!line) return;

    // Add to history
    this.commandHistory.push(line);
    this.historyIndex = this.commandHistory.length;

    // Check if it's a command
    if (line.startsWith('/')) {
      await this.handleCommand(line);
    } else {
      await this.sendTask(line);
    }
  }

  /**
   * Handle REPL command
   */
  private async handleCommand(line: string): Promise<void> {
    const parts = line.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
        this.showHelp();
        break;
        
      case 'status':
        await this.showStatus();
        break;
        
      case 'list':
        await this.listWorkflows();
        break;
        
      case 'pause':
        if (this.currentWorkflowId) {
          await this.client.pause(this.currentWorkflowId);
          printSuccess('Workflow paused');
        } else {
          printError('No active workflow');
        }
        break;
        
      case 'resume':
        if (this.currentWorkflowId) {
          await this.client.resume(this.currentWorkflowId);
          printSuccess('Workflow resumed');
        } else {
          printError('No active workflow');
        }
        break;
        
      case 'cancel':
        if (this.currentWorkflowId) {
          await this.client.cancel(this.currentWorkflowId);
          printSuccess('Workflow cancelled');
          this.currentWorkflowId = null;
        } else {
          printError('No active workflow');
        }
        break;
        
      case 'switch':
        if (args[0]) {
          this.currentWorkflowId = args[0];
          printSuccess(`Switched to workflow ${args[0]}`);
        } else {
          printError('Usage: /switch <workflow-id>');
        }
        break;
        
      case 'new':
        this.currentWorkflowId = null;
        this.currentSessionId = `session-${Date.now()}`;
        printSuccess('Started new session');
        break;
        
      case 'json':
        setOutputFormat('json');
        printSuccess('Output format: JSON');
        break;
        
      case 'text':
        setOutputFormat('text');
        printSuccess('Output format: Text');
        break;
        
      case 'clear':
        console.clear();
        break;
        
      case 'exit':
      case 'quit':
        await this.stop();
        break;
        
      default:
        printError(`Unknown command: ${cmd}`);
        console.log('Type /help for available commands');
    }
  }

  /**
   * Show help
   */
  private showHelp(): void {
    console.log(`
Commands:
  /help              Show this help
  /status            Show current workflow status
  /list              List all workflows
  /pause             Pause current workflow
  /resume            Resume current workflow
  /cancel            Cancel current workflow
  /switch <id>       Switch to another workflow
  /new               Start a new session
  /json              Set output format to JSON
  /text              Set output format to text
  /clear             Clear screen
  /exit              Exit REPL

Any other input will be sent as a task to the orchestrator.
`);
  }

  /**
   * Show current workflow status
   */
  private async showStatus(): Promise<void> {
    if (!this.currentWorkflowId) {
      console.log('No active workflow');
      return;
    }

    try {
      const status = await this.client.getStatus(this.currentWorkflowId);
      printWorkflowStatus(status);
    } catch (error) {
      printError('Failed to get status', error);
    }
  }

  /**
   * List all workflows
   */
  private async listWorkflows(): Promise<void> {
    try {
      const workflows = await this.client.listWorkflows();
      if (workflows.length === 0) {
        console.log('No workflows');
        return;
      }
      
      console.log('Workflows:');
      workflows.forEach(w => {
        const active = w.workflowId === this.currentWorkflowId ? ' *' : '';
        console.log(`  ${w.workflowId.slice(0, 12)}: ${w.simplifiedStatus} (${w.fsmState})${active}`);
      });
    } catch (error) {
      printError('Failed to list workflows', error);
    }
  }

  /**
   * Send task to orchestrator
   */
  private async sendTask(task: string): Promise<void> {
    try {
      if (!this.currentWorkflowId) {
        // Start new workflow
        const result = await this.client.orchestrate(task, { sessionId: this.currentSessionId });
        this.currentWorkflowId = result.workflowId;
        printSuccess(`Started workflow: ${result.workflowId}`);
      } else {
        // Send input to existing workflow
        await this.client.sendInput(this.currentWorkflowId, task);
        printSuccess('Input sent');
      }
    } catch (error) {
      printError('Failed to send task', error);
    }
  }

  /**
   * Handle runtime event
   */
  private handleEvent(event: RuntimeEvent): void {
    // Print event (will be formatted by output module)
    printEvent(event.type, event.payload, event.timestamp);
  }

  /**
   * Handle user decision request
   */
  private async handleDecision(decision: UserDecision): Promise<string> {
    return new Promise((resolve) => {
      // Pause normal prompt
      this.rl.pause();
      
      // Show decision prompt
      console.log(`\n❓ ${decision.message}`);
      if (decision.options) {
        decision.options.forEach((opt, i) => {
          console.log(`  ${i + 1}. ${opt}`);
        });
      }
      
      // Create temporary readline for decision
      const decisionRl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      
      decisionRl.question('> ', async (answer) => {
        decisionRl.close();
        
        // Map numeric answer to option
        let response = answer.trim();
        if (decision.options && /^\d+$/.test(response)) {
          const index = parseInt(response) - 1;
          if (index >= 0 && index < decision.options.length) {
            response = decision.options[index];
          }
        }
        
        // Resume normal prompt
        this.rl.resume();
        this.promptUser();
        
        resolve(response);
      });
    });
  }
}

/**
 * Start REPL from CLI
 */
export async function startREPL(config: REPLConfig = {}): Promise<void> {
  const repl = new FingerREPL(config);
  
  // Handle Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\n');
    await repl.stop();
    process.exit(0);
  });
  
  await repl.start();
}
