interface RuntimeInstruction {
  content: string;
  createdAt: string;
}

class RuntimeInstructionBus {
  private queues: Map<string, RuntimeInstruction[]> = new Map();

  push(workflowId: string, content: string): void {
    const normalized = content.trim();
    if (!normalized) return;

    const queue = this.queues.get(workflowId) ?? [];
    queue.push({
      content: normalized,
      createdAt: new Date().toISOString(),
    });
    this.queues.set(workflowId, queue);
  }

  consume(workflowId: string): string[] {
    const queue = this.queues.get(workflowId);
    if (!queue || queue.length === 0) return [];

    this.queues.delete(workflowId);
    return queue.map((item) => item.content);
  }
}

export const runtimeInstructionBus = new RuntimeInstructionBus();
