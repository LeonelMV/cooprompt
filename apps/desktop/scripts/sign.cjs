// electron-builder `mac.sign` hook. With the self-signed identity in ~/.cooprompt-signing (created once by
// scripts/signing-identity.mjs) every build carries the same signature, so installed copies only take
// updates built by its owner. Without it the build is signed ad hoc, as electron-builder would.
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join } = require('node:path');

const signingDir = () => process.env.COOPROMPT_SIGNING_DIR || join(homedir(), '.cooprompt-signing');

/**
 * Runs `fn({ identity, env })` with the identity imported into a throwaway keychain that a temporary
 * HOME makes the default one: codesign only finds identities in the keychain search list, and this
 * way the user's keychains and preferences are never touched. The certificate is not trusted, which
 * codesign accepts.
 */
async function withSigningKeychain(dir, fn) {
  const home = mkdtempSync(join(tmpdir(), 'cooprompt-sign-'));
  const keychain = join(home, 'Library', 'Keychains', 'login.keychain-db');
  const env = { ...process.env, HOME: home };
  const security = (...args) => execFileSync('/usr/bin/security', args, { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const password = randomBytes(24).toString('hex');
  try {
    mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
    security('create-keychain', '-p', password, keychain);
    security('set-keychain-settings', keychain);
    security('unlock-keychain', '-p', password, keychain);
    security('import', join(dir, 'identity.p12'), '-k', keychain, '-f', 'pkcs12', '-P', readFileSync(join(dir, 'p12.pass'), 'utf8').trim(), '-T', '/usr/bin/codesign');
    security('set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain);
    const identity = /\b([0-9A-F]{40})\b/.exec(security('find-identity', '-p', 'codesigning', keychain))?.[1];
    if (!identity) throw new Error(`No code-signing identity in ${dir}`);
    return await fn({ identity, env });
  } finally {
    try {
      security('delete-keychain', keychain);
    } catch {
      // Removed with the folder below.
    }
    rmSync(home, { recursive: true, force: true });
  }
}

exports.signingDir = signingDir;
exports.withSigningKeychain = withSigningKeychain;

exports.default = async function sign(options) {
  const { signAsync } = require('@electron/osx-sign');
  const dir = signingDir();
  if (!existsSync(join(dir, 'identity.p12'))) {
    console.log(`  • signing ad hoc: no identity in ${dir} (create one with npm run signing-identity)`);
    return signAsync(options);
  }
  await withSigningKeychain(dir, async ({ identity, env }) => {
    console.log(`  • signing with the CooPrompt identity ${identity}`);
    const home = process.env.HOME;
    // @electron/osx-sign runs codesign with this process's environment.
    process.env.HOME = env.HOME;
    try {
      await signAsync({
        ...options,
        identity,
        identityValidation: false,
        optionsForFile: (file) => ({ ...(options.optionsForFile ? options.optionsForFile(file) : {}), timestamp: 'none' }),
      });
    } finally {
      process.env.HOME = home;
    }
  });
};
