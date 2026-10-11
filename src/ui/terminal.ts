import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
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
    input: ({ message, default: fallback, validate }) =>
      prompt(() =>
        input({
          message: label(message),
          ...(fallback !== undefined ? { default: fallback } : {}),
          ...(validate ? { validate } : {}),
        }),
      ),
    checkbox: ({ message, choices, default: checked = [], required = false }) =>
      prompt(() =>
        checkbox({
          message: label(message),
          required,
          choices: choices.map((choice) => ({
            name: choice.name,
            value: choice.value,
            checked: checked.includes(choice.value),
            ...(choice.disabled !== undefined ? { disabled: choice.disabled } : {}),
          })),
        }),
      ),

    editFile: (path) => openInEditor(path),

    async task(text, run, done) {
      const spinner = yoctoSpinner({ text }).start();
      try {
        const result = await run((update) => {
          spinner.text = update;
        });
        spinner.success(done ? done(result) : text);
        return result;
      } catch (error) {
        spinner.error(spinner.text);
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

/** The user's editor; may include arguments, e.g. `code --wait`. */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.VISUAL || env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
}

function openInEditor(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(`${editorCommand()} "${path}"`, { shell: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`The editor exited with code ${String(code)}.`));
    });
  });
}

/** Dim helper for secondary text (hints, paths). */
export const dim = (text: string): string => styleText('dim', text);
