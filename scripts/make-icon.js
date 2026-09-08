'use strict';
/**
 * Generates assets/icon.png and build/icon.ico from scratch.
 * Written by hand with zlib so the project needs no image toolchain and the
 * icon can be regenerated (or restyled) with `npm run icon`.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ drawing

const lerp = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle, used for crisp anti-aliased edges. */
function roundedRectSDF(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function pixels() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const half = SIZE * 0.44;
  const radius = SIZE * 0.235;          // Windows 11 "squircle" proportions

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const d = roundedRectSDF(x + 0.5, y + 0.5, cx, cy, half, half, radius);
      const coverage = Math.max(0, Math.min(1, 0.5 - d));   // 1px AA band
      if (coverage <= 0) continue;

      // Diagonal gradient: indigo -> violet, with a light catch top-left.
      const t = Math.max(0, Math.min(1, (x / SIZE) * 0.6 + (y / SIZE) * 0.6));
      let r = lerp(0x5b, 0xb4, t);
      let g = lerp(0x8c, 0x8c, t);
      let b = lerp(0xff, 0xff, t);

      const sheen = Math.max(0, 1 - Math.hypot(x - SIZE * 0.28, y - SIZE * 0.22) / (SIZE * 0.55));
      r = lerp(r, 255, sheen * 0.35);
      g = lerp(g, 255, sheen * 0.35);
      b = lerp(b, 255, sheen * 0.35);

      // The mark: a clock hand sweep — a ring with a gap, plus a centre dot.
      const dist = Math.hypot(x - cx, y - cy);
      const ringR = SIZE * 0.245;
      const ringW = SIZE * 0.038;
      const angle = Math.atan2(y - cy, x - cx);
      const inGap = angle > -Math.PI * 0.62 && angle < -Math.PI * 0.06;
      const ring = Math.abs(dist - ringR) < ringW / 2 && !inGap;
      const dot = dist < SIZE * 0.055;
      // Hand pointing to roughly 10 o'clock.
      const handAngle = -Math.PI * 0.34;
      const px = Math.cos(handAngle), py = Math.sin(handAngle);
      const proj = (x - cx) * px + (y - cy) * py;
      const perp = Math.abs((x - cx) * -py + (y - cy) * px);
      const hand = proj > 0 && proj < SIZE * 0.2 && perp < SIZE * 0.021;

      if (ring || dot || hand) { r = 255; g = 255; b = 255; }

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(coverage * 255);
    }
  }
  return buf;
}

// --------------------------------------------------------------- PNG output

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

function png(rgba) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Vista-era ICO: a container holding the PNG verbatim. */
function ico(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);          // type: icon
  header.writeUInt16LE(1, 4);          // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0;                        // 0 means 256px
  entry[1] = 0;
  entry[2] = 0;                        // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);           // colour planes
  entry.writeUInt16LE(32, 6);          // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);         // offset
  return Buffer.concat([header, entry, pngBuffer]);
}

const rgba = pixels();
const pngBuffer = png(rgba);

fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), pngBuffer);
fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(pngBuffer));

console.log(`icon.png  ${pngBuffer.length} bytes`);
console.log(`icon.ico  ${ico(pngBuffer).length} bytes`);
