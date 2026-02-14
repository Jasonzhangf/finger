import { BaseBlock, type BlockCapabilities } from '../../core/block.js';
import type { Event } from '../../core/types.js';

type EventHandler = (event: Event) => void | Promise<void>;

export class EventBusBlock extends BaseBlock {
  readonly type = 'eventbus';
  readonly capabilities: BlockCapabilities = {
    functions: ['emit', 'subscribe', 'unsubscribe', 'history'],
    cli: [
      { name: 'emit', description: 'Emit an event', args: [] },
      { name: 'history', description: 'Show event history', args: [] }
    ],
    stateSchema: {
      subscriptions: { type: 'number', readonly: true, description: 'Subscription count' },
      eventsEmitted: { type: 'number', readonly: true, description: 'Total events emitted' }
    }
  };

  private subscribers: Map<string, Set<EventHandler>> = new Map();
  private history: Event[] = [];
  private maxHistory = 1000;

  constructor(id: string) {
    super(id, 'eventbus');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'emit':
        return this.emit(args as unknown as Omit<Event<unknown>, 'id' | 'timestamp'>);
      case 'subscribe':
        return this.subscribe(args.type as string, args.handler as EventHandler);
      case 'unsubscribe':
        return this.unsubscribe(args.type as string, args.handler as EventHandler);
      case 'history':
        return this.getHistory(args.type as string | undefined);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  async emit(eventData: Omit<Event<unknown>, 'id' | 'timestamp'>): Promise<Event> {
    const event: Event = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...eventData,
      timestamp: new Date()
    };

    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const handlers = this.subscribers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (err) {
          console.error(`Event handler error for ${event.type}:`, err);
        }
      }
    }

    this.updateState({
      data: {
        eventsEmitted: this.history.length,
        lastEvent: event.type
      }
    });

    return event;
  }

  subscribe(type: string, handler: EventHandler): { subscribed: boolean } {
    if (!this.subscribers.has(type)) {
      this.subscribers.set(type, new Set());
    }
    this.subscribers.get(type)!.add(handler);

    this.updateState({
      data: { subscriptions: this.getTotalSubscriptions() }
    });

    return { subscribed: true };
  }

  unsubscribe(type: string, handler: EventHandler): { unsubscribed: boolean } {
    const handlers = this.subscribers.get(type);
    if (!handlers) return { unsubscribed: false };

    const result = handlers.delete(handler);
    this.updateState({
      data: { subscriptions: this.getTotalSubscriptions() }
    });

    return { unsubscribed: result };
  }

  getHistory(type?: string): Event[] {
    if (!type) return [...this.history];
    return this.history.filter(e => e.type === type);
  }

  private getTotalSubscriptions(): number {
    let total = 0;
    for (const handlers of this.subscribers.values()) {
      total += handlers.size;
    }
    return total;
  }
}
