export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;

  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
