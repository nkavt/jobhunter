export interface Choice<T> {
  name: string;
  value: T;
  description?: string;
  /** `true` or a reason shown next to the greyed-out choice. */
  disabled?: boolean | string;
}

/** Everything commands need from the terminal; tests replace it with a scripted fake. */
export interface Ui {
  select<T>(options: { message: string; choices: Choice<T>[]; default?: T }): Promise<T>;
  password(options: {
    message: string;
    validate?: (value: string) => true | string;
  }): Promise<string>;
  confirm(options: { message: string; default?: boolean }): Promise<boolean>;
  /** Show a spinner while `run` works; ✔ `done` on success, ✖ on failure (the error is rethrown). */
  task<T>(text: string, run: () => Promise<T>, done?: (result: T) => string): Promise<T>;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Thrown when the user aborts a prompt (Ctrl+C). */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}
