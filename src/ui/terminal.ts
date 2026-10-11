import { confirm, input, select } from '@inquirer/prompts';
import { styleText } from 'node:util';
import yoctoSpinner from 'yocto-spinner';
import { CancelledError, type Ui } from './types.js';

/** Inquirer throws `ExitPromptError` on Ctrl+C; turn it into our own error type. */
async function prompt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') throw new CancelledError();
    throw error;
  }
}

/** `AI provider` → `AI provider:`; questions keep their `?`. */
export function label(message: string): string {
  return /[?:]$/.test(message.trimEnd()) ? message : `${message}:`;
}

const mask = (value: string): string => '*'.repeat(value.length);

export function createTerminalUi(): Ui {
  return {
    select: (options) => prompt(() => select({ ...options, message: label(options.message) })),
    // The text prompt with a masking transformer, not inquirer's password prompt: the latter
    // drops the space after the label until you start typing, gluing the cursor to it.
    password: ({ message, validate }) =>
      prompt(() =>
        input({
          message: label(message),
          transformer: (value, { isFinal }) =>
            isFinal ? styleText('cyan', mask(value)) : mask(value),
          ...(validate ? { validate } : {}),
        }),
      ),
    confirm: (options) => prompt(() => confirm({ ...options, message: label(options.message) })),

    async task(text, run, done) {
      const spinner = yoctoSpinner({ text }).start();
      try {
        const result = await run();
        spinner.success(done ? done(result) : text);
        return result;
      } catch (error) {
        spinner.error(text);
        throw error;
      }
    },

    info: (message) => {
      console.log(message);
    },
    success: (message) => {
      console.log(`${styleText('green', '✔')} ${message}`);
    },
    warn: (message) => {
      console.warn(`${styleText('yellow', '⚠')} ${message}`);
    },
    error: (message) => {
      console.error(`${styleText('red', '✖')} ${message}`);
    },
  };
}

/** Dim helper for secondary text (hints, paths). */
export const dim = (text: string): string => styleText('dim', text);
