import type { Command } from 'commander';
import { notImplemented } from './not-implemented.js';

export function registerCommands(program: Command): void {
  program
    .command('init')
    .description('Set up Claude, import your CV, answer a few questions and connect Google Sheets')
    .action(notImplemented('init', 'jh-8'));

  program
    .command('discover')
    .description('Let the AI find new job feeds that match your profile')
    .action(notImplemented('discover', 'jh-24'));

  program
    .command('hunt')
    .description('Fetch all saved feeds, skip known jobs, and add new ones to your sheet')
    .action(notImplemented('hunt', 'jh-25'));

  program
    .command('map')
    .description('Generate a field mapping for a job feed sample')
    .argument('<source>', 'file path or URL of a feed sample (JSON or XML)')
    .action(notImplemented('map', 'jh-14'));

  program
    .command('convert')
    .description('Convert a job feed to the canonical format using its saved mapping')
    .argument('<source>', 'file path or URL of a feed (JSON or XML)')
    .action(notImplemented('convert', 'jh-14'));

  program
    .command('sync')
    .description('Apply "Change status" picks from the status tabs to the master sheet')
    .action(notImplemented('sync', 'jh-23'));
}
