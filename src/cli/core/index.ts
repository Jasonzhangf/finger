/**
 * Finger Core CLI Commands
 */

import { Command } from "commander";
import { daemonCommand } from "./daemon.js";
import { sendCommand } from "./send.js";
import { listCommand } from "./list.js";

export function createCoreCLI(): Command {
  const program = new Command();
  
  program
    .name("finger-core")
    .description("Finger Core Daemon - Simple message routing system")
    .version("0.1.0");

  program.addCommand(daemonCommand());
  program.addCommand(sendCommand());
  program.addCommand(listCommand());

  return program;
}

export { daemonCommand, sendCommand, listCommand };
