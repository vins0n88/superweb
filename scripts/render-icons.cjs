// Rasterizes assets/*.svg with Electron and builds the macOS .icns.
//   npx electron scripts/render-icons.cjs
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const ICONSET_SIZES = [16, 32, 128, 256, 512];

let win;

async function render(svgFile, width, height, outFile) {
  win ??= new BrowserWindow({
    show: false, frame: false, transparent: true, webPreferences: { offscreen: true },
  });
  win.setContentSize(width, height);
  const svg = fs.readFileSync(path.join(ASSETS, svgFile), 'utf8');
  const html = `<html><body style="margin:0;background:transparent">
    <img width="${width}" height="${height}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
  const page = path.join(app.getPath('temp'), `superweb-render-${process.pid}-${svgFile}.html`);
  fs.writeFileSync(page, html);
  try {
    await win.loadFile(page);
  } finally {
    fs.rmSync(page, { force: true });
  }
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  fs.writeFileSync(outFile, image.resize({ width, height, quality: 'best' }).toPNG());
}

app.whenReady().then(async () => {
  const icon = path.join(ASSETS, 'icon.png');
  await render('icon.svg', 1024, 1024, icon);
  await render('logo.svg', 1400, 520, path.join(ASSETS, 'logo.png'));

  const iconset = path.join(ASSETS, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  for (const size of ICONSET_SIZES) {
    execFileSync('sips', ['-z', String(size), String(size), icon, '--out', path.join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(size * 2), String(size * 2), icon, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ASSETS, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true });
  console.log('wrote assets/icon.png, assets/logo.png, assets/icon.icns');
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
