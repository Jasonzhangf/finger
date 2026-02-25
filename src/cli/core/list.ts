/**
 * List Command - List registered services
 */

import { Command } from "commander";
import { registry } from "../../core/registry-new.js";

export function listCommand(): Command {
  return new Command("list")
    .description("List registered services")
    .option("-t, --type <type>", "Filter by type (input|output)")
    .option("--json", "Output as JSON")
    .action((options) => {
      const filter = options.type ? { type: options.type as "input" | "output" } : undefined;
      const entries = registry.list(filter);

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (entries.length === 0) {
        console.log("No services registered");
        return;
      }

      console.log("Registered Services:");
      console.log("-".repeat(60));

      for (const entry of entries) {
        const status = entry.status === "active" ? "✓" : "✗";
        console.log(`[${status}] ${entry.id} (${entry.type}/${entry.kind})`);
      }

      console.log("-".repeat(60));
      console.log(`Routes: ${registry.getRoutes().length}`);
    });
}
