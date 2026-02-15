#!/usr/bin/env node

import { program } from 'commander';
import { registerLoopTestCommand } from './loop-test.js';
import { registerIflowCommand } from './iflow.js';
import { registerDaemonCommand } from './daemon.js';

program
  .name('fingerdaemon')
  .description('Finger - AI Agent Orchestrator')
  .version('0.1.0');

// Register commands
registerLoopTestCommand(program);
registerIflowCommand(program);
registerDaemonCommand(program);

// Block commands
program
  .command('block list')
  .description('List all registered blocks')
  .action(async () => {
    console.log('No blocks registered yet. Initialize the system first.');
    // TODO: Connect to BlockRegistry
  });

// Status command
program
  .command('status')
  .description('Show system status')
  .action(() => {
    console.log('Finger Orchestrator - Not initialized');
  });

program.parse();
