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
  /** Pick any number of choices; `default` lists the pre-checked values. */
  checkbox<T>(options: {
    message: string;
    choices: Choice<T>[];
    default?: T[];
    /** At least one choice must be picked. */
    required?: boolean;
  }): Promise<T[]>;
  /** Free text; an empty answer returns `default` when one is given. */
  input(options: {
    message: string;
    default?: string;
    validate?: (value: string) => true | string;
  }): Promise<string>;
  password(options: {
    message: string;
    validate?: (value: string) => true | string;
  }): Promise<string>;
  confirm(options: { message: string; default?: boolean }): Promise<boolean>;
  /** Open a file in the user's editor ($VISUAL / $EDITOR) and wait until it's closed. */
  editFile(path: string): Promise<void>;
  /**
   * Show a spinner while `run` works; ✔ `done` on success, ✖ on failure (the error is rethrown).
   * `run` can call `update` to change the spinner text, e.g. to show progress.
   */
  task<T>(
    text: string,
    run: (update: (text: string) => void) => Promise<T>,
    done?: (result: T) => string,
  ): Promise<T>;
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
