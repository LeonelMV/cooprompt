import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const plist = (values: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${Object.entries(values)
  .map(([key, value]) => `  <key>${key}</key><string>${value}</string>`)
  .join('\n')}
</dict></plist>
`;

/**
 * A minimal app bundle signed ad hoc, or with `sign`. Its executable is a copy of /usr/bin/true that
 * never runs: the fake `open` below plays the app.
 */
export async function makeApp(dir: string, version: string, options: { name?: string; id?: string; sign?: (app: string) => void } = {}): Promise<string> {
  const name = options.name ?? 'Fake';
  const app = join(dir, `${name}.app`);
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(join(app, 'Contents', 'Resources'), { recursive: true });
  await copyFile('/usr/bin/true', join(app, 'Contents', 'MacOS', name));
  await writeFile(join(app, 'Contents', 'Resources', 'payload.txt'), `build ${version}\n`);
  await writeFile(
    join(app, 'Contents', 'Info.plist'),
    plist({
      CFBundleIdentifier: options.id ?? 'dev.cooprompt.fake',
      CFBundleExecutable: name,
      CFBundleName: name,
      CFBundlePackageType: 'APPL',
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
    }),
  );
  if (options.sign) options.sign(app);
  else execFileSync('codesign', ['--force', '--timestamp=none', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}

export const versionOf = (app: string): string => execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')]).toString().trim();

/**
 * Stand-in for open(1), first on the helper's PATH. It records what it opens; when that is version
 * FAKE_NEW_VERSION it plays the new app as FAKE_NEW_BEHAVIOR says: `confirm` creates FAKE_CONFIRM
 * like a healthy launch, `hang` keeps running without confirming (seen by ps at the bundle's real
 * path, as LaunchServices starts apps), anything else dies before confirming.
 */
export async function fakeOpen(dir: string): Promise<{ bin: string; log: string }> {
  const bin = join(dir, 'bin');
  const log = join(dir, 'opened.log');
  await mkdir(bin, { recursive: true });
  await writeFile(log, '');
  await writeFile(
    join(bin, 'open'),
    `#!/bin/bash
app=$1
printf '%s\\n' "$app" >> "$FAKE_OPEN_LOG"
info="$app/Contents/Info.plist"
[ "$(plutil -extract CFBundleShortVersionString raw -o - "$info" 2>/dev/null)" = "\${FAKE_NEW_VERSION:-}" ] || exit 0
real="$(cd "$(dirname "$app")" && pwd -P)/$(basename "$app")"
case "\${FAKE_NEW_BEHAVIOR:-}" in
  confirm) : > "$FAKE_CONFIRM" ;;
  hang) (exec -a "$real/Contents/MacOS/$(plutil -extract CFBundleExecutable raw -o - "$info")" /bin/sleep 60) >/dev/null 2>&1 & ;;
esac
exit 0
`,
  );
  await chmod(join(bin, 'open'), 0o755);
  return { bin, log };
}
