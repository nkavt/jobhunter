import type { Command } from 'commander';
import { registerCompanies } from './companies/index.js';
import { registerHunt } from './hunt/index.js';
import { registerInit } from './init/index.js';
import { registerMap } from './map/index.js';
import { registerSheet } from './sheet/index.js';
import { notImplemented } from './not-implemented.js';

export function registerCommands(program: Command): void {
  registerInit(program);
  registerHunt(program);
  registerCompanies(program);
  registerMap(program);
  registerSheet(program);

  program
    .command('discover')
    .description('Let the AI find new job feeds that match your profile')
    .action(notImplemented('discover'));

  program
    .command('convert')
    .description('Convert a job feed to the canonical format using its saved mapping')
    .argument('<source>', 'file path or URL of a feed (JSON or XML)')
    .action(notImplemented('convert'));

  program
    .command('sync')
    .description('Apply "Change status" picks from the status tabs to the master sheet')
    .action(notImplemented('sync'));
}
