import { afterEach, describe, expect, it, vi } from 'vitest';

const exitPromptError = Object.assign(new Error('User force closed the prompt'), {
  name: 'ExitPromptError',
});

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(() => Promise.reject(exitPromptError)),
  input: vi.fn(() => Promise.resolve('sk-ant-x')),
  confirm: vi.fn(() => Promise.reject(new Error('boom'))),
}));

vi.mock('yocto-spinner', () => ({
  default: () => {
    const spinner = { start: () => spinner, success: vi.fn(), error: vi.fn() };
    return spinner;
  },
}));

const { createTerminalUi, label } = await import('../../src/ui/terminal.js');
const prompts = await import('@inquirer/prompts');
const { CancelledError } = await import('../../src/ui/types.js');

describe('terminal UI', () => {
  afterEach(() => vi.restoreAllMocks());

  it('turns Ctrl+C in a prompt into CancelledError', async () => {
    await expect(
      createTerminalUi().select({ message: 'x', choices: [{ name: 'a', value: 'a' }] }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it('passes other prompt errors through and returns answers', async () => {
    const ui = createTerminalUi();
    await expect(ui.confirm({ message: 'x' })).rejects.toThrow('boom');
    expect(await ui.password({ message: 'key' })).toBe('sk-ant-x');
  });

  it('adds a colon to labels but not to questions', () => {
    expect(label('AI provider')).toBe('AI provider:');
    expect(label('Change the model?')).toBe('Change the model?');
    expect(label('Key:')).toBe('Key:');
  });

  it('masks the key while typing and in the final answer', async () => {
    await createTerminalUi().password({ message: 'Anthropic API key' });
    const config = vi.mocked(prompts.input).mock.calls[0]?.[0];
    expect(config?.message).toBe('Anthropic API key:');
    expect(config?.transformer?.('sk-ant', { isFinal: false })).toBe('******');
    expect(config?.transformer?.('sk-ant', { isFinal: true })).toContain('******');
    expect(config?.transformer?.('sk-ant', { isFinal: true })).not.toContain('sk-ant');
  });

  it('runs tasks and rethrows their errors', async () => {
    const ui = createTerminalUi();
    expect(
      await ui.task(
        'Working…',
        () => Promise.resolve(42),
        (n) => `Got ${String(n)}`,
      ),
    ).toBe(42);
    await expect(ui.task('Failing…', () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
  });

  it('prints status messages with symbols', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ui = createTerminalUi();

    ui.success('Saved');
    ui.error('Failed');
    ui.warn('Careful');
    ui.info('Plain');

    expect(String(log.mock.calls[0]?.[0])).toContain('Saved');
    expect(String(error.mock.calls[0]?.[0])).toContain('✖');
    expect(String(warn.mock.calls[0]?.[0])).toContain('⚠');
    expect(log.mock.calls[1]?.[0]).toBe('Plain');
  });
});
