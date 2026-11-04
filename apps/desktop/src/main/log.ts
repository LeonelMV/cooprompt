import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let logFile: string | null = null;

export function setLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
}

export function log(scope: string, ...parts: unknown[]): void {
  const line = `${new Date().toISOString()} [${scope}] ${parts
    .map((part) => (part instanceof Error ? (part.stack ?? part.message) : typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ')}`;
  console.log(line);
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      // Logging must never break the app.
    }
  }
}
