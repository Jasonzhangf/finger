/**
 * Send Command - Send message to destination
 */

import { Command } from "commander";
import { createMessage } from "../../core/schema.js";
import { registry } from "../../core/registry-new.js";

export function sendCommand(): Command {
  return new Command("send")
    .description("Send message to destination")
    .argument("<dest>", "Destination output ID")
    .argument("<payload>", "JSON payload")
    .option("-t, --type <type>", "Message type", "command")
    .option("--trace <traceId>", "Trace ID")
    .action(async (dest, payload, options) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = payload;
      }

      const message = createMessage(options.type, parsed, "cli", {
        dest,
        traceId: options.trace,
      });

      const output = registry.get(dest);
      if (!output || output.type !== "output") {
        console.error("Destination not found:", dest);
        process.exit(1);
      }

      console.log("Sending to", dest);
      console.log(JSON.stringify(message, null, 2));
      console.log("Note: Run daemon first");
    });
}
