import { describe, expect, it, vi, afterEach } from 'vitest';
import { createProgram } from '../src/program.js';
import { VERSION } from '../src/version.js';

function run(args: string[]) {
  const program = createProgram();
  let output = '';
  // Subcommands copy these settings only at creation time, so apply them to every command.
  for (const command of [program, ...program.commands]) {
    command.exitOverride().configureOutput({
      writeOut: (str) => (output += str),
      writeErr: (str) => (output += str),
    });
  }
  return {
    program,
    parse: () => program.parseAsync(['node', 'jobhunter', ...args]),
    output: () => output,
  };
}

describe('jobhunter CLI', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('prints the package version', async () => {
    const cli = run(['--version']);
    await expect(cli.parse()).rejects.toMatchObject({ code: 'commander.version' });
    expect(cli.output().trim()).toBe(VERSION);
  });

  it('lists the planned commands in --help', async () => {
    const cli = run(['--help']);
    await expect(cli.parse()).rejects.toMatchObject({ code: 'commander.helpDisplayed' });
    for (const command of ['init', 'discover', 'hunt', 'map', 'convert', 'sync']) {
      expect(cli.output()).toContain(command);
    }
  });

  it('reports stub commands as not implemented with a non-zero exit code', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await run(['init']).parse();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('`jobhunter init` is not implemented yet'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('requires a source argument for map', async () => {
    const cli = run(['map']);
    await expect(cli.parse()).rejects.toMatchObject({ code: 'commander.missingArgument' });
  });
});
