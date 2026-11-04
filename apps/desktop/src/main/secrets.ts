import { safeStorage } from 'electron';
import { readFile, rename, writeFile } from 'node:fs/promises';

/**
 * Values are stored locally using Electron safeStorage and are never sent to the collaboration
 * server. Its platform provider uses Keychain on macOS and DPAPI on Windows. The async API keeps
 * a system permission prompt from freezing the app.
 */
export class Secrets {
  private readonly file: string;
  private readonly plain = new Map<string, string>();
  private encrypted: Record<string, string> = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    try {
      this.encrypted = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      this.encrypted = {};
    }
    const rotate: string[] = [];
    for (const [key, value] of Object.entries(this.encrypted)) {
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'));
        this.plain.set(key, result);
        if (shouldReEncrypt) rotate.push(key);
      } catch {
        // Unreadable with the current OS protection key: treat as missing.
      }
    }
    for (const key of rotate) this.set(key, this.plain.get(key) ?? null);
  }

  get(key: string): string | null {
    return this.plain.get(key) ?? null;
  }

  getJson<T>(key: string): T | null {
    const value = this.get(`json:${key}`);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  has(key: string): boolean {
    return this.plain.has(key);
  }

  /** Updates memory immediately; encryption and the write happen in order in the background. */
  set(key: string, value: string | null): void {
    if (value === null || value === '') this.plain.delete(key);
    else this.plain.set(key, value);
    this.writing = this.writing
      .then(async () => {
        const current = this.plain.get(key);
        if (current === undefined) delete this.encrypted[key];
        else this.encrypted[key] = (await safeStorage.encryptStringAsync(current)).toString('base64');
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, JSON.stringify(this.encrypted), { mode: 0o600 });
        await rename(tmp, this.file);
      })
      .catch((error) => console.error('could not save a secret', error));
  }

  setJson(key: string, value: unknown): void {
    this.set(`json:${key}`, value === null || value === undefined ? null : JSON.stringify(value));
  }

  flush(): Promise<void> {
    return this.writing;
  }

  /** Every stored secret value, used to redact them from anything published to the chat. */
  values(): string[] {
    const values: string[] = [];
    for (const [key, value] of this.plain) {
      if (key.startsWith('json:')) {
        try {
          collectStrings(JSON.parse(value), values);
        } catch {
          // ignore malformed entries
        }
      } else values.push(value);
    }
    return values.filter((value) => value.length >= 8);
  }
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => collectStrings(entry, out));
}
