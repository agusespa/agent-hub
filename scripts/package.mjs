import { readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { packager } from '@electron/packager';

/** The app runs only from these; everything else in the project stays out of the bundle. */
const KEEP = /^\/(package\.json$|dist(\/|$)|public(\/|$)|hooks(\/|$)|node_modules(\/|$))/;

/**
 * Tool caches such as node_modules/.vitest-cache, and the SDK's bundled Claude binary (~260 MB):
 * the board always runs the `claude` CLI on PATH instead.
 */
const DROP = /^\/node_modules\/(\.|@anthropic-ai\/claude-agent-sdk-[^/]+(\/|$))/;

/** Removes folders left empty under `dir`, such as the scopes of pruned devDependencies. */
const removeEmptyFolders = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyFolders(path.join(dir, entry.name));
  }
  if ((await readdir(dir)).length === 0) await rmdir(dir);
};

// Paths are relative to the project and start with `/`; the project folder itself is ''.
// Packager still drops devDependencies on its own, but keeps their folders, so those are swept after.
// The icon goes in as prebuilt files rather than through packager's `icon` option, which would
// compile build/icon.icon with Xcode's actool on every package. `npm run icon` builds them.
const [appPath] = await packager({
  dir: '.',
  out: 'out',
  overwrite: true,
  extraResource: ['build/icon.icns', 'build/Assets.car'],
  extendInfo: { CFBundleIconFile: 'icon.icns', CFBundleIconName: 'Icon' },
  ignore: (file) => file !== '' && (!KEEP.test(file) || DROP.test(file)),
  afterPrune: [({ buildPath }) => removeEmptyFolders(path.join(buildPath, 'node_modules'))],
});
console.log(`Wrote ${appPath}`);
