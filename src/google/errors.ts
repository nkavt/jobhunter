/** A Google setup or sign-in problem the user can act on; the message says what to do. */
export class GoogleAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GoogleAuthError';
  }
}
