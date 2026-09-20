'use strict';
/**
 * Push the current source into the already-built app, without electron-builder.
 *
 *   npm run refresh
 *
 * Why this exists: a packaged Electron app is the Electron runtime plus one
 * archive of this project's files. Only the archive changes when the code
 * changes, so replacing it is the whole update. electron-builder does that as
 * part of a much larger job which, on a machine without Developer Mode, cannot
 * finish at all — it unpacks a code-signing bundle containing macOS symlinks,
 * and Windows refuses to create symlinks for an unprivileged process. That
 * failure has nothing to do with this app and blocks every rebuild.
 *
 * So: stage the files the build config lists, pack them with the asar tool that
 * is already a dependency, and drop the result into the unpacked build.
 * Run `npm run dist` for a real installer when you need one.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const unpacked = path.join(root, 'dist', 'win-unpacked');
const target = path.join(unpacked, 'resources', 'app.asar');
const stage = path.join(root, 'dist', '.stage');

// Mirrors the "files" list in package.json's build config.
const INCLUDE = ['src', 'assets', 'package.json'];

function copy(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) copy(path.join(from, entry), path.join(to, entry));
    return;
  }
  if (from.endsWith('.map')) return;          // excluded by the build config
  fs.copyFileSync(from, to);
}

if (!fs.existsSync(unpacked)) {
  console.error('No dist/win-unpacked to refresh. Run `npm run pack` once first.');
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const entry of INCLUDE) copy(path.join(root, entry), path.join(stage, entry));

// Run the tool's own entry point under this Node rather than the .bin shim: a
// .cmd shim would need a shell, and passing arguments through one is a hazard
// the runtime rightly warns about.
const asar = path.join(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
execFileSync(process.execPath, [asar, 'pack', stage, target], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });

const size = fs.statSync(target).size;
console.log(`refreshed ${path.relative(root, target)} (${(size / 1024).toFixed(0)} KB)`);
console.log(`run it:   "${path.join(unpacked, 'HR Dock.exe')}"`);
