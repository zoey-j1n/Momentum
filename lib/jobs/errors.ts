// Thrown by a handler to tell the queue "do not retry this". Lives here, not in the handler, because the
// queue has to recognise it and the queue must not depend on any particular handler.
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}
