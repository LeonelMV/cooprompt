import { randomInt } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCooPromptServer, DEFAULT_MAX_PARALLEL_TURNS, DEFAULT_MIN_INTERVAL_MINUTES, latestRelease, parseAllowedDomains, type InstallerFile } from './server.ts';

const env = process.env;
const dataDir = resolve(env.COOPROMPT_DATA_DIR ?? join(homedir(), '.cooprompt-server'));

/** The access code persists across restarts so shared invites keep working. */
async function resolveAccessCode(): Promise<string | null> {
  if (env.COOPROMPT_ACCESS_CODE !== undefined) return env.COOPROMPT_ACCESS_CODE.trim() || null;
  const file = join(dataDir, 'access-code.txt');
  const existing = await readFile(file, 'utf8').then((value) => value.trim(), () => '');
  if (existing) return existing;
  const code = String(randomInt(100000, 999999));
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, `${code}\n`, { mode: 0o600 });
  return code;
}

const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
const google =
  googleClientId && googleClientSecret
    ? { clientId: googleClientId, clientSecret: googleClientSecret, allowedDomains: parseAllowedDomains(env.GOOGLE_ALLOWED_DOMAINS ?? '') }
    : null;
const passwordAuth = env.COOPROMPT_PASSWORD_AUTH !== 'false';
const maxParallelTurns = env.COOPROMPT_MAX_PARALLEL_TURNS ? Number(env.COOPROMPT_MAX_PARALLEL_TURNS) || undefined : undefined;
/** For trying automations out: lets them run as often as every N minutes. */
const automationMinInterval = env.COOPROMPT_AUTOMATION_MIN_INTERVAL ? Number(env.COOPROMPT_AUTOMATION_MIN_INTERVAL) || undefined : undefined;

/**
 * The installer is COOPROMPT_INSTALLER_ZIP (announced to clients as COOPROMPT_INSTALLER_VERSION), or the
 * latest build `npm run dist` left in apps/desktop/release.
 */
async function installer(): Promise<InstallerFile | null> {
  if (env.COOPROMPT_INSTALLER_ZIP) return { path: resolve(env.COOPROMPT_INSTALLER_ZIP), version: env.COOPROMPT_INSTALLER_VERSION?.trim() || null };
  return latestRelease(resolve(dirname(fileURLToPath(import.meta.url)), '../../desktop/release'));
}

const accessCode = await resolveAccessCode();
const server = await createCooPromptServer({
  dataDir,
  host: env.HOST ?? '0.0.0.0',
  port: Number(env.PORT ?? 4317),
  name: env.COOPROMPT_SERVER_NAME ?? 'CooPrompt',
  google,
  passwordAuth,
  accessCode,
  installer,
  maxParallelTurns,
  automations: { minIntervalMinutes: automationMinInterval },
});

console.log(`\nCooPrompt server listening (data in ${dataDir})`);
for (const url of server.urls) console.log(`  → ${url}`);
console.log(`  Google: ${google ? `enabled${google.allowedDomains.length ? ` (${google.allowedDomains.join(', ')})` : ''}` : 'disabled (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)'}`);
const parallel = Math.max(1, Math.floor(maxParallelTurns ?? DEFAULT_MAX_PARALLEL_TURNS));
console.log(`  Multitask: ${parallel > 1 ? `up to ${parallel} turns at once per chat` : 'off (COOPROMPT_MAX_PARALLEL_TURNS=1)'}`);
console.log(`  Automations: at least ${automationMinInterval ?? DEFAULT_MIN_INTERVAL_MINUTES} minutes between runs`);
if (passwordAuth) console.log(`  Access code for email sign-up: ${accessCode ?? '(not required)'}\n`);
else console.log(`  Email sign-up and sign-in: disabled (COOPROMPT_PASSWORD_AUTH=false)${google ? '' : '. Without Google sign-in nobody can sign in.'}\n`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
