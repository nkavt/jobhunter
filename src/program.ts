import { Command } from 'commander';
import { registerCommands } from './commands/index.js';
import { VERSION } from './version.js';

export function createProgram(): Command {
  const program = new Command()
    .name('jobhunter')
    .description('Discover job feeds, normalise listings and track them in Google Sheets')
    .version(VERSION, '-v, --version');

  registerCommands(program);
  return program;
}
