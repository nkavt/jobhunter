/** Setup isn't complete enough to hunt; the message says what to do. */
export class HuntSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HuntSetupError';
  }
}
