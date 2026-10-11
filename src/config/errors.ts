/** A config/profile file exists but can't be read or doesn't match its schema. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/** Jobhunter hasn't been set up yet (or the requested profile doesn't exist). */
export class NotInitializedError extends Error {
  constructor(message = 'Jobhunter is not set up yet. Run `jobhunter init` first.') {
    super(message);
    this.name = 'NotInitializedError';
  }
}
