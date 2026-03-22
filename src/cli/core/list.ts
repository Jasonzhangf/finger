/**
 * List Command - List registered services
 */

import { Command } from "commander";
import { registry } from "../../core/registry-new.js";
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const clog = createConsoleLikeLogger('List');

export function listCommand(): Command {
  return new Command("list")
    .description("List registered services")
    .option("-t, --type <type>", "Filter by type (input|output)")
    .option("--json", "Output as JSON")
    .action((options) => {
      const filter = options.type ? { type: options.type as "input" | "output" } : undefined;
      const entries = registry.list(filter);

      if (options.json) {
        clog.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (entries.length === 0) {
        clog.log("No services registered");
        return;
      }

      clog.log("Registered Services:");
      clog.log("-".repeat(60));

      for (const entry of entries) {
        const status = entry.status === "active" ? "✓" : "✗";
        clog.log(`[${status}] ${entry.id} (${entry.type}/${entry.kind})`);
      }

      clog.log("-".repeat(60));
      clog.log(`Routes: ${registry.getRoutes().length}`);
    });
}
