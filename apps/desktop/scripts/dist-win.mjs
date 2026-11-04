#!/usr/bin/env node
// Build on Windows so the native engine binaries match the installer architecture.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 is required to build this installer.');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
const version = pkg.version.replace(/^(\d+)\.(\d+)\.(\d+)$/, (_, major, minor, patch) => `${major}.${minor}.${Number(patch) + 1}`);
if (version === pkg.version) throw new Error(`Invalid version: ${pkg.version}`);
const bin = (name) => join(root, '..', '..', 'node_modules', '.bin', `${name}.cmd`);
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: true });
run(bin('electron-vite'), ['build']);
execFileSync(process.execPath, [join(root, 'scripts', 'stage-engines.mjs')], { cwd: root, stdio: 'inherit' });
run(bin('electron-builder'), ['--win', '--x64', '--config', 'electron-builder.yml', `--config.extraMetadata.version=${version}`]);
pkg.version = version;
writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
