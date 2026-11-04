#!/usr/bin/env node
// Copies the native engine binaries (Claude Code and Codex) into build/engines so electron-builder
// ships them as extraResources outside the asar archive (see src/main/paths.ts).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const arch = process.env.COOPROMPT_ARCH ?? process.arch;
const platform = process.platform;
if (!['darwin', 'win32'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
const triple = platform === 'win32'
  ? (arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc')
  : (arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin');
const suffix = platform === 'win32' ? '.exe' : '';
const out = join(root, 'build', 'engines');

const packageDir = (name) => dirname(require.resolve(`${name}/package.json`));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'claude'), { recursive: true });

const claude = join(packageDir(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`), `claude${suffix}`);
if (!existsSync(claude)) throw new Error(`Falta el binario de Claude Code: ${claude}`);
cpSync(claude, join(out, 'claude', `claude${suffix}`));

const codex = join(packageDir(`@openai/codex-${platform}-${arch}`), 'vendor', triple);
if (!existsSync(join(codex, 'bin', `codex${suffix}`))) throw new Error(`Falta el binario de Codex: ${codex}`);
cpSync(codex, join(out, 'codex', triple), { recursive: true });

console.log(`motores copiados a ${out} (${arch})`);
