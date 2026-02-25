/**
 * Finger Core Daemon - Service Registry
 * 
 * Manages registration of inputs, outputs, and routes
 */

import type { RegistryEntry, RouteRule } from './schema.js';

export class Registry {
  private entries: Map<string, RegistryEntry> = new Map();
  private routes: RouteRule[] = [];

  register(entry: Omit<RegistryEntry, 'lastHeartbeat'>): void {
    this.entries.set(entry.id, {
      ...entry,
      lastHeartbeat: Date.now(),
    });
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  list(filter?: { type?: 'input' | 'output' }): RegistryEntry[] {
    const entries = Array.from(this.entries.values());
    if (filter?.type) {
      return entries.filter((e) => e.type === filter.type);
    }
    return entries;
  }

  heartbeat(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.lastHeartbeat = Date.now();
    }
  }

  // Routes
  addRoute(route: RouteRule): void {
    this.routes.push(route);
    this.routes.sort((a, b) => b.priority - a.priority);
  }

  removeRoute(id: string): boolean {
    const index = this.routes.findIndex((r) => r.id === id);
    if (index >= 0) {
      this.routes.splice(index, 1);
      return true;
    }
    return false;
  }

  getRoutes(): RouteRule[] {
    return [...this.routes];
  }

  matchRoutes(message: { type: string; meta: { source: string } }): string[] {
    const destinations: string[] = [];
    
    for (const route of this.routes) {
      const matchType = !route.match.type || route.match.type === message.type;
      const matchSource = !route.match.source || route.match.source === message.meta.source;
      
      if (matchType && matchSource) {
        destinations.push(...route.dest);
      }
    }
    
    return [...new Set(destinations)];
  }

  // Snapshot
  toSnapshot(): { entries: RegistryEntry[]; routes: RouteRule[] } {
    return {
      entries: Array.from(this.entries.values()),
      routes: this.routes,
    };
  }

  fromSnapshot(snapshot: { entries: RegistryEntry[]; routes: RouteRule[] }): void {
    this.entries.clear();
    for (const entry of snapshot.entries) {
      this.entries.set(entry.id, entry);
    }
    this.routes = snapshot.routes;
  }
}

export const registry = new Registry();
