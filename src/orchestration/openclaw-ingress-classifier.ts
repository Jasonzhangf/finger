/**
 * OpenClaw Ingress Classifier
 * Classifies incoming messages and routes them to appropriate handlers
 */

export interface IngressMessage {
  id: string;
  source: 'discord' | 'slack' | 'webhook' | 'api' | 'email' | 'unknown';
  channel?: string;
  threadId?: string;
  accountId?: string;
  content: string | Record<string, unknown>;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface ClassifiedMessage {
  original: IngressMessage;
  category: 'command' | 'question' | 'notification' | 'task' | 'conversation' | 'unknown';
  confidence: number; // 0-1
  extractedData: {
    command?: string;
    arguments?: Record<string, unknown>;
    sessionId?: string;
    agentId?: string;
    taskId?: string;
    mentions?: string[];
    tags?: string[];
  };
  suggestedAction: 'route_to_agent' | 'route_to_orchestrator' | 'store_in_mailbox' | 'require_review' | 'ignore';
  reasoning: string;
}

export class IngressClassifier {
  /**
   * Classify incoming message
   */
  classify(message: IngressMessage): ClassifiedMessage {
    const contentStr = this.extractContentString(message.content);
    
    // Check for explicit commands (must be before task keywords)
    const commandMatch = this.matchCommand(contentStr);
    if (commandMatch) {
      return {
        original: message,
        category: 'command',
        confidence: 0.9,
        extractedData: {
          command: commandMatch.name,
          arguments: commandMatch.args,
        },
        suggestedAction: 'route_to_agent',
        reasoning: `Explicit command detected: ${commandMatch.name}`,
      };
    }

    // Check for task-related keywords (but exclude if it starts with /)
    if (!contentStr.startsWith('/') && this.hasTaskKeywords(contentStr)) {
      return {
        original: message,
        category: 'task',
        confidence: 0.7,
        extractedData: {
          tags: this.extractTags(contentStr),
        },
        suggestedAction: 'route_to_orchestrator',
        reasoning: 'Task-related keywords detected',
      };
    }

    // Check for questions
    const questionIndicators = ['?', 'what', 'how', 'why', 'when', 'where', 'who', 'can', 'could', 'would', 'should'];
    if (this.containsKeywords(contentStr, questionIndicators)) {
      return {
        original: message,
        category: 'question',
        confidence: 0.6,
        extractedData: {},
        suggestedAction: 'route_to_agent',
        reasoning: 'Question format detected',
      };
    }

    // Check for mentions/notifications
    const mentions = this.extractMentions(contentStr);
    if (mentions.length > 0 || message.source === 'webhook') {
      return {
        original: message,
        category: 'notification',
        confidence: 0.8,
        extractedData: { mentions },
        suggestedAction: 'store_in_mailbox',
        reasoning: 'Mentions or webhook detected',
      };
    }

    // Default: conversation
    return {
      original: message,
      category: 'conversation',
      confidence: 0.5,
      extractedData: {
        tags: this.extractTags(contentStr),
      },
      suggestedAction: 'route_to_agent',
      reasoning: 'Default conversation classification',
    };
  }

  /**
   * Batch classify multiple messages
   */
  classifyBatch(messages: IngressMessage[]): ClassifiedMessage[] {
    return messages.map(m => this.classify(m));
  }

  /**
   * Extract content as string
   */
  private extractContentString(content: string | Record<string, unknown>): string {
    if (typeof content === 'string') return content;
    if (content.text) return String(content.text);
    if (content.message) return String(content.message);
    return JSON.stringify(content);
  }

  /**
   * Match explicit command pattern: /command arg1=value1 arg2=value2
   * Supports hyphens in command names
   */
  private matchCommand(content: string): { name: string; args: Record<string, unknown> } | null {
    // Match /command or /command-name (allow hyphens)
    const commandRegex = /^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/;
    const match = content.match(commandRegex);
    
    if (!match) return null;

    const name = match[1];
    const argsStr = match[2] || '';
    const args: Record<string, unknown> = {};

    // Parse key=value arguments
    const argPairs = argsStr.match(/(\w+)=([^\s]+)/g);
    if (argPairs) {
      for (const pair of argPairs) {
        const [key, value] = pair.split('=');
        args[key] = value;
      }
    }

    return { name, args };
  }

  /**
   * Check if content has task-related keywords
   */
  private hasTaskKeywords(content: string): boolean {
    const taskKeywords = ['create', 'update', 'delete', 'execute', 'run', 'start', 'stop'];
    return this.containsKeywords(content, taskKeywords);
  }

  /**
   * Check if content contains keywords
   */
  private containsKeywords(content: string, keywords: string[]): boolean {
    const lowerContent = content.toLowerCase();
    return keywords.some(kw => lowerContent.includes(kw.toLowerCase()));
  }

  /**
   * Extract mentions (e.g., @user, #channel)
   */
  private extractMentions(content: string): string[] {
    const mentions: string[] = [];
    const mentionRegex = /[@#](\w+)/g;
    let match;
    
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1]);
    }

    return mentions;
  }

  /**
   * Extract tags (e.g., #tag)
   */
  private extractTags(content: string): string[] {
    const tags: string[] = [];
    const tagRegex = /#(\w+)/g;
    let match;
    
    while ((match = tagRegex.exec(content)) !== null) {
      tags.push(match[1]);
    }

    return tags;
  }
}

// Global classifier instance
export const ingressClassifier = new IngressClassifier();
