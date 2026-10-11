/** A Google setup or sign-in problem the user can act on; the message says what to do. */
export class GoogleAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GoogleAuthError';
  }
}

/** A Google API call failed; `status` is the HTTP status (0 when Google couldn't be reached). */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GoogleApiError';
  }
}
