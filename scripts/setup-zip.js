'use strict';
/**
 * Bundle the installer with its install note into one zip.
 *
 *   npm run dist        (runs this afterwards on its own)
 *
 * The installer is unsigned, so the first thing anyone who receives it sees is
 * a SmartScreen warning. A bare .exe gives them nothing to read before that
 * happens; the zip puts the explanation — why the warning appears, how to get
 * past it, how to upgrade without losing data — in the same place as the file.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { version, productName } = pkg;

const dist = path.join(root, 'dist');
const installer = path.join(dist, `${productName} Setup ${version}.exe`);
const zip = path.join(dist, `${productName} ${version} Setup.zip`);
const stage = path.join(dist, '.setup-stage');

if (!fs.existsSync(installer)) {
  console.error(`No installer at ${path.relative(root, installer)} — run \`npm run dist\` first.`);
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

fs.copyFileSync(installer, path.join(stage, path.basename(installer)));
const note = fs.readFileSync(path.join(root, 'build', 'INSTALL.txt'), 'utf8')
  .replace(/\{version\}/g, version)
  .replace(/\r?\n/g, '\r\n');            // it will be opened in Notepad
fs.writeFileSync(path.join(stage, 'INSTALL.txt'), note);

// The archiver electron-builder already depends on, rather than a new one.
const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
fs.rmSync(zip, { force: true });
execFileSync(sevenZip, ['a', '-tzip', '-mx=5', zip, path.join(stage, '*')], { stdio: 'ignore' });
fs.rmSync(stage, { recursive: true, force: true });

const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
console.log(`setup zip: ${path.relative(root, zip)} (${mb} MB)`);
