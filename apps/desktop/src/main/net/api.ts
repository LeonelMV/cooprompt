import { translateMessage } from '../../shared/i18n.ts';
import { language, tr } from '../i18n.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function normalizeServerUrl(input: string): string {
  let value = input.trim();
  if (!value) throw new Error(tr('Enter the server URL'));
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  const url = new URL(value);
  // Node resolves localhost to ::1 first while the server listens on IPv4.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return `${url.protocol}//${url.host}`;
}

export class ApiClient {
  private readonly getBase: () => string | null;
  private readonly getToken: () => string | null;

  constructor(getBase: () => string | null, getToken: () => string | null) {
    this.getBase = getBase;
    this.getToken = getToken;
  }

  base(): string {
    const base = this.getBase();
    if (!base) throw new Error(tr('No server is configured'));
    return base;
  }

  async request<T>(method: string, path: string, body?: unknown, options: { base?: string; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    const token = options.auth === false ? null : this.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${options.base ?? this.base()}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ApiError(0, tr('Could not connect to the server ({error})', { error: error instanceof Error ? error.message : String(error) }));
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new ApiError(response.status, translateMessage(language(), String(payload.error ?? `Error ${response.status}`)), payload);
    return payload as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** Raw request for workspace file transfer (streams in both directions). */
  async raw(method: string, path: string, body?: ReadableStream<Uint8Array> | Uint8Array, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {};
    const token = this.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body) headers['content-type'] = 'application/octet-stream';
    const init: RequestInit & { duplex?: 'half' } = { method, headers, body: body as BodyInit | undefined, signal };
    if (body instanceof ReadableStream) init.duplex = 'half';
    return fetch(`${this.base()}${path}`, init);
  }
}
