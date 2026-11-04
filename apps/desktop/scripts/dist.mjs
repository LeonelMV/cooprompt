#!/usr/bin/env node
// Builds the macOS installer. electron-builder runs in a temp folder because codesign refuses
// bundles assembled inside ~/Desktop (Finder/File Provider metadata); artifacts are copied back.
// Each build gets the next patch version (COOPROMPT_VERSION=x.y.z picks one instead), recorded in
// package.json once the build succeeds, so installed copies see it as an update. release/latest-mac.json
// names the build that servers hand out and announce. Extra arguments go to electron-builder.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(tmpdir(), 'cooprompt-release');
const release = join(root, 'release');
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
const manifest = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
const version = process.env.COOPROMPT_VERSION ?? pkg.version.replace(/^(\d+)\.(\d+)\.(\d+)$/, (_, major, minor, patch) => `${major}.${minor}.${Number(patch) + 1}`);
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Versión inválida: "${version}" (tiene que ser x.y.z)`);
console.log(`CooPrompt ${version}`);

/** Copies into the release folder under a temporary name first, so servers never see half a file. */
const publish = (from, name, contents) => {
  const tmp = join(release, `.${name}.tmp`);
  if (contents === undefined) copyFileSync(from, tmp);
  else writeFileSync(tmp, contents);
  renameSync(tmp, join(release, name));
  console.log(`→ ${join(release, name)}`);
};

rmSync(output, { recursive: true, force: true });
run('npx', ['electron-vite', 'build']);
run(process.execPath, [join(root, 'scripts', 'stage-engines.mjs')]);
run('npx', ['electron-builder', '--mac', '--arm64', '--config', 'electron-builder.yml', `--config.directories.output=${output}`, `--config.extraMetadata.version=${version}`, ...process.argv.slice(2)]);

mkdirSync(release, { recursive: true });
const artifacts = readdirSync(output).filter((file) => /\.(dmg|zip)$/.test(file));
for (const file of artifacts) publish(join(output, file), file);
const zip = artifacts.find((file) => file.endsWith('-mac.zip'));
if (zip) publish(null, 'latest-mac.json', `${JSON.stringify({ version, file: zip }, null, 2)}\n`);
rmSync(output, { recursive: true, force: true });

pkg.version = version;
writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
