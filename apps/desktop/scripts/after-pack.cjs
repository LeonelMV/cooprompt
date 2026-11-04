// codesign rejects bundles carrying Finder metadata ("resource fork, Finder information, or similar
// detritus"), which folders like ~/Desktop pick up. Strip extended attributes before signing.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('xattr', ['-cr', app]);
};
