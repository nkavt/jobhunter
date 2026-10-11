import { confirm, password, select } from '@inquirer/prompts';
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

export function createTerminalUi(): Ui {
  return {
    select: (options) => prompt(() => select(options)),
    password: ({ message, validate }) =>
      prompt(() => password({ message, mask: '*', ...(validate ? { validate } : {}) })),
    confirm: (options) => prompt(() => confirm(options)),

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
