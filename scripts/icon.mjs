// Renders public/icon.svg into build/icon.png (Dock icon for `npm run app`) and
// build/icon.icns (bundle icon for `npm run package`). Run with `npm run icon`.
// build/icon.icon is the macOS 26+ version, kept by hand; edit it in Icon Composer.
// With Xcode installed this also compiles it into build/Assets.car, so packaging never needs Xcode.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

const SIZE = 1024;
const svg = path.resolve('public/icon.svg');
const png = path.resolve('build/icon.png');
const icns = path.resolve('build/icon.icns');
const iconComposer = path.resolve('build/icon.icon');
const assetCatalog = path.resolve('build/Assets.car');

const render = async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    enableLargerThanScreen: true,
  });
  const page = `<style>body{margin:0;background:transparent}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${readFileSync(svg, 'utf8')}`;
  await window.loadURL(`data:text/html,${encodeURIComponent(page)}`);
  // On a Retina screen the capture comes back at 2x; scale it to exactly SIZE.
  const image = (await window.capturePage()).resize({ width: SIZE, height: SIZE, quality: 'best' });
  mkdirSync(path.dirname(png), { recursive: true });
  writeFileSync(png, image.toPNG());

  // iconutil wants every size at 1x and 2x, named icon_<size>x<size>[@2x].png.
  const iconset = path.join(mkdtempSync(path.join(tmpdir(), 'agent-hub-')), 'icon.iconset');
  execFileSync('mkdir', [iconset]);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const out = path.join(iconset, `icon_${size}x${size}${suffix}.png`);
      execFileSync('sips', ['-z', String(size * scale), String(size * scale), png, '--out', out], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  rmSync(path.dirname(iconset), { recursive: true });

  console.log(`Wrote ${png} and ${icns}`);

  try {
    execFileSync('actool', ['--version'], { stdio: 'ignore' });
  } catch {
    console.log(`Kept ${assetCatalog}: compiling ${iconComposer} needs Xcode 26 or later`);
    return;
  }
  // actool names the catalog's icon after the .icon folder; package.mjs points CFBundleIconName at 'Icon'.
  const work = mkdtempSync(path.join(tmpdir(), 'agent-hub-'));
  execFileSync('cp', ['-R', iconComposer, path.join(work, 'Icon.icon')]);
  execFileSync('actool', [
    path.join(work, 'Icon.icon'),
    '--compile', work,
    '--output-partial-info-plist', path.join(work, 'info.plist'),
    '--app-icon', 'Icon',
    '--include-all-app-icons',
    '--target-device', 'mac',
    '--platform', 'macosx',
    '--minimum-deployment-target', '26.0',
  ], { stdio: 'ignore' });
  execFileSync('cp', [path.join(work, 'Assets.car'), assetCatalog]);
  rmSync(work, { recursive: true });
  console.log(`Wrote ${assetCatalog}`);
};

// No top-level await: Electron does not fire `ready` until the ESM entry module has finished evaluating.
app.dock?.hide();
app
  .whenReady()
  .then(render)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
