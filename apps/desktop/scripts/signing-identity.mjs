#!/usr/bin/env node
// Creates, once, the self-signed code-signing identity that scripts/sign.cjs signs every build with,
// using only tools that ship with macOS. It never overwrites an existing identity.
// Usage: node scripts/signing-identity.mjs [folder]   (default: $COOPROMPT_SIGNING_DIR or ~/.cooprompt-signing)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? process.env.COOPROMPT_SIGNING_DIR ?? join(homedir(), '.cooprompt-signing'));
const openssl = (args, env = {}) => execFileSync('/usr/bin/openssl', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const fingerprint = () => openssl(['x509', '-in', join(dir, 'cert.pem'), '-noout', '-fingerprint', '-sha1']).trim().split('=').pop().replaceAll(':', '');

if (existsSync(join(dir, 'identity.p12'))) {
  console.log(`Ya existe una identidad de firma en ${dir} (SHA-1 ${fingerprint()}): no se cambió nada.`);
  process.exit(0);
}

process.umask(0o077);
mkdirSync(dir, { recursive: true });
const config = join(dir, 'openssl.cnf');
const key = join(dir, 'key.pem');
writeFileSync(
  config,
  [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    'CN = CooPrompt Signing',
    '[ext]',
    'basicConstraints = critical, CA:false',
    'keyUsage = critical, digitalSignature',
    'extendedKeyUsage = critical, codeSigning',
    'subjectKeyIdentifier = hash',
    '',
  ].join('\n'),
);
try {
  openssl(['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '7300', '-nodes', '-config', config, '-extensions', 'ext', '-keyout', key, '-out', join(dir, 'cert.pem')]);
  const password = randomBytes(24).toString('hex');
  writeFileSync(join(dir, 'p12.pass'), password);
  // macOS LibreSSL writes PKCS#12 in the format `security import` accepts.
  openssl(['pkcs12', '-export', '-inkey', key, '-in', join(dir, 'cert.pem'), '-name', 'CooPrompt Signing', '-out', join(dir, 'identity.p12'), '-passout', 'env:COOPROMPT_P12_PASS'], { COOPROMPT_P12_PASS: password });
} catch (error) {
  rmSync(dir, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(key, { force: true });
  rmSync(config, { force: true });
}

console.log(`Identidad de firma de CooPrompt creada en ${dir}
  SHA-1: ${fingerprint()}

Desde ahora "npm run dist" firma CooPrompt con ella, y las copias instaladas sólo aceptan actualizaciones
firmadas con esta misma identidad.

Hacé una copia de seguridad de esa carpeta (por ejemplo en tu gestor de contraseñas o en un disco
cifrado). Si se pierde, las builds firmadas con una identidad nueva son rechazadas y cada colega
tiene que reinstalar CooPrompt una vez.`);
