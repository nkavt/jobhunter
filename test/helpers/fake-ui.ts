import { stripVTControlCharacters } from 'node:util';
import { CancelledError, type Choice, type Ui } from '../../src/ui/index.js';

/** Answer with the prompt's default value. */
export const DEFAULT = Symbol('default answer');
/** Simulate Ctrl+C on this prompt. */
export const CANCEL = Symbol('cancel');

/** Compute the answer from what the prompt offers, e.g. pick a choice by its label. */
export type DynamicAnswer = (prompt: { message: string; choices: Choice<unknown>[] }) => unknown;

export interface RecordedPrompt {
  type: 'select' | 'password' | 'confirm';
  message: string;
  choices?: Choice<unknown>[];
}

const strip = (text: string) => stripVTControlCharacters(text);

/**
 * Scripted stand-in for the terminal. Answers prompts in order and records everything
 * that was shown, so tests can assert on the conversation.
 */
export class FakeUi implements Ui {
  readonly prompts: RecordedPrompt[] = [];
  readonly output: string[] = [];
  private readonly answers: unknown[];

  constructor(answers: unknown[]) {
    this.answers = [...answers];
  }

  get remainingAnswers(): number {
    return this.answers.length;
  }

  select<T>(options: { message: string; choices: Choice<T>[]; default?: T }): Promise<T> {
    this.prompts.push({
      type: 'select',
      message: strip(options.message),
      choices: options.choices,
    });
    const answer = this.next('select', options.message);
    const value =
      answer === DEFAULT
        ? options.default
        : typeof answer === 'function'
          ? (answer as DynamicAnswer)({ message: options.message, choices: options.choices })
          : answer;
    const choice = options.choices.find((c) => c.value === value);
    if (!choice || choice.disabled) {
      throw new Error(`"${String(value)}" is not an enabled choice for "${options.message}"`);
    }
    return Promise.resolve(choice.value);
  }

  password(options: {
    message: string;
    validate?: (value: string) => true | string;
  }): Promise<string> {
    this.prompts.push({ type: 'password', message: strip(options.message) });
    const answer = this.next('password', options.message);
    if (typeof answer !== 'string') throw new Error(`password answer must be a string`);
    const valid = options.validate?.(answer) ?? true;
    if (valid !== true) throw new Error(`password "${answer}" rejected by validation: ${valid}`);
    return Promise.resolve(answer);
  }

  confirm(options: { message: string; default?: boolean }): Promise<boolean> {
    this.prompts.push({ type: 'confirm', message: strip(options.message) });
    const answer = this.next('confirm', options.message);
    return Promise.resolve(answer === DEFAULT ? (options.default ?? false) : Boolean(answer));
  }

  async task<T>(text: string, run: () => Promise<T>, done?: (result: T) => string): Promise<T> {
    try {
      const result = await run();
      this.output.push(`✔ ${done ? done(result) : text}`);
      return result;
    } catch (error) {
      this.output.push(`✖ ${text}`);
      throw error;
    }
  }

  info(message: string): void {
    this.output.push(strip(message));
  }
  success(message: string): void {
    this.output.push(`✔ ${strip(message)}`);
  }
  warn(message: string): void {
    this.output.push(`⚠ ${strip(message)}`);
  }
  error(message: string): void {
    this.output.push(`✖ ${strip(message)}`);
  }

  private next(type: string, message: string): unknown {
    if (this.answers.length === 0)
      throw new Error(`No scripted answer for ${type}: "${strip(message)}"`);
    const answer = this.answers.shift();
    if (answer === CANCEL) throw new CancelledError();
    return answer;
  }
}
