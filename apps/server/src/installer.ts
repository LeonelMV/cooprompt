import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppRelease } from '@cooprompt/protocol';
import { HttpError } from './errors.ts';

/** A zipped CooPrompt.app; without a version it is served but not announced as an update. */
export interface InstallerFile {
  path: string;
  version: string | null;
}

/** The installer this server hands out right now, or null when unavailable. */
export type InstallerSource = () => Promise<InstallerFile | null>;

/** Longest a health check waits for the build to be described; a slower one is announced on a later check. */
const DESCRIBE_WAIT_MS = 1500;

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Describes the build `/download/CooPrompt.zip` serves by hashing that exact file, once per path,
 * version, size and modification time, so a rebuilt zip is never announced with a stale checksum.
 */
export function releaseDescriber(source: InstallerSource | null): () => Promise<AppRelease | undefined> {
  let memo: { key: string; release: Promise<AppRelease | null> } | null = null;
  const describe = async (): Promise<AppRelease | null> => {
    const file = source ? await source() : null;
    if (!file?.version) return null;
    const info = await stat(file.path).catch(() => null);
    if (!info?.isFile()) return null;
    const key = [file.path, file.version, info.size, info.mtimeMs].join('\0');
    if (memo?.key !== key) {
      const version = file.version;
      memo = { key, release: sha256(file.path).then((hash) => ({ version, sha256: hash, size: info.size }), () => null) };
    }
    return memo.release;
  };
  return async () => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DESCRIBE_WAIT_MS);
    });
    try {
      return (await Promise.race([describe().catch(() => null), late])) ?? undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The build `npm run dist` left in a release folder: the one its `latest-mac.json` names, or else
 * the newest `*-mac.zip`, served without announcing a version.
 */
export async function latestRelease(dir: string): Promise<InstallerFile | null> {
  try {
    const latest = JSON.parse(await readFile(join(dir, 'latest-mac.json'), 'utf8')) as { version?: unknown; file?: unknown };
    if (typeof latest.version === 'string' && typeof latest.file === 'string' && basename(latest.file) === latest.file) {
      const path = join(dir, latest.file);
      if ((await stat(path)).isFile()) return { path, version: latest.version };
    }
  } catch {
    // No manifest, or it names a file that is gone.
  }
  const zips = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('-mac.zip'));
  const dated = await Promise.all(zips.map(async (name) => ({ path: join(dir, name), mtime: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
  const newest = dated.sort((a, b) => b.mtime - a.mtime)[0];
  return newest ? { path: newest.path, version: null } : null;
}

type Language = 'en' | 'es';

const TEXT: Record<Language, Record<'arch' | 'download' | 'install' | 'done', string>> = {
  en: {
    arch: 'CooPrompt needs a Mac with Apple silicon (M1 chip or later).',
    download: 'Downloading CooPrompt from $SERVER (about 370 MB)...',
    install: 'Installing into $DEST...',
    done: 'Done: CooPrompt is installed in $DEST and connected to $SERVER.',
  },
  es: {
    arch: 'CooPrompt necesita una Mac con chip Apple (M1 o posterior).',
    download: 'Descargando CooPrompt desde $SERVER (unos 370 MB)...',
    install: 'Instalando en $DEST...',
    done: 'Listo: CooPrompt quedo instalado en $DEST y conectado a $SERVER.',
  },
};

function publicBase(request: FastifyRequest): string {
  const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const visitor = String(request.headers['cf-visitor'] ?? '');
  const proto = forwardedProto || (visitor.includes('https') ? 'https' : request.protocol);
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0].trim();
  return `${proto}://${host}`;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * One-line install for teammates: `curl -fsSL <server>/install | bash`. Files fetched by curl are
 * not quarantined, so the app, which is not notarized, opens without Gatekeeper prompts, already
 * pointed at this server and in the language of the invitation.
 */
function script(base: string, name: string, language: Language): string {
  const text = TEXT[language];
  return `#!/bin/bash
# CooPrompt installer served by "${name.replace(/["$`\\]/g, '')}".
set -euo pipefail
SERVER=${quote(base)}

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "${text.arch}"
  exit 1
fi

DEST="\${COOPROMPT_INSTALL_DIR:-/Applications}"
if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "${text.download}"
curl -fL --progress-bar "$SERVER/download/CooPrompt.zip" -o "$TMP/CooPrompt.zip"

osascript -e 'quit app "CooPrompt"' >/dev/null 2>&1 || true
echo "${text.install}"
rm -rf "$DEST/CooPrompt.app"
ditto -x -k "$TMP/CooPrompt.zip" "$DEST"
xattr -cr "$DEST/CooPrompt.app" 2>/dev/null || true

CONFIG="$HOME/Library/Application Support/CooPrompt"
mkdir -p "$CONFIG"
if [ ! -f "$CONFIG/settings.json" ]; then
  printf '{"serverUrl":"%s","language":"${language}"}' "$SERVER" > "$CONFIG/settings.json"
fi

open "$DEST/CooPrompt.app"
echo "${text.done}"
`;
}

export function registerInstallerRoutes(app: FastifyInstance, input: { name: string; installer: InstallerSource | null }): void {
  const sendScript = async (request: FastifyRequest, reply: FastifyReply, fallback: Language) => {
    const requested = (request.query as { lang?: string }).lang;
    const language: Language = requested === 'es' || requested === 'en' ? requested : fallback;
    reply.header('content-type', 'text/x-shellscript; charset=utf-8');
    return script(publicBase(request), input.name, language);
  };
  app.get('/install', (request, reply) => sendScript(request, reply, 'en'));
  app.get('/instalar', (request, reply) => sendScript(request, reply, 'es'));

  const sendZip = async (_request: FastifyRequest, reply: FastifyReply) => {
    const path = (await input.installer?.())?.path;
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !info) throw new HttpError(404, 'This server has no CooPrompt installer available');
    reply.header('content-type', 'application/zip');
    reply.header('content-length', String(info.size));
    reply.header('content-disposition', 'attachment; filename="CooPrompt.zip"');
    return reply.send(createReadStream(path));
  };
  app.get('/download/CooPrompt.zip', sendZip);
  app.get('/descargar/CooPrompt.zip', sendZip);
}
