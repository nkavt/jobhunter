import { Command } from 'commander';
import { registerCommands } from './commands/index.js';
import { VERSION } from './version.js';

export function createProgram(): Command {
  const program = new Command()
    .name('jobhunter')
    .description('Score remote jobs against your CV with AI and track them in a Google Sheet')
    .version(VERSION, '-v, --version');

  registerCommands(program);
  return program;
}
