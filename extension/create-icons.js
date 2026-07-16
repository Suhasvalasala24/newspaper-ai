/**
 * create-icons.js — generates extension/icons/icon16.png, icon48.png, icon128.png
 * Uses only Node.js built-in modules (zlib, fs, path) — no npm install needed.
 *
 * Run from the project root:
 *   node extension/create-icons.js
 */
'use strict';

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// CRC32 (required by PNG spec for each chunk)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body      = Buffer.concat([typeBytes, data]);
  const crc       = u32BE(crc32(body));
  return Buffer.concat([u32BE(data.length), body, crc]);
}

/**
 * Creates a PNG of a red circle (#C0392B) with a white "N" letter.
 * Uses a simple rasterised approach — circle via distance formula, letter via
 * a hand-crafted 5×7 bitmap scaled to fit. No canvas library needed.
 */
function createIconPNG(size) {
  const r = 192, g = 57, b = 43; // #C0392B

  // ------------------------------------------------------------------
  // Step 1: build RGBA pixel grid
  // ------------------------------------------------------------------
  const pixels = new Uint8Array(size * size * 4); // RGBA

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size / 2;

  // 5×7 bitmap for letter "N" (columns left→right, rows top→bottom)
  const NBMP = [
    [1,0,0,0,1],
    [1,1,0,0,1],
    [1,0,1,0,1],
    [1,0,0,1,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
  ];

  const letterH = NBMP.length;     // 7
  const letterW = NBMP[0].length;  // 5

  // Scale factor so the letter fills ~50% of the circle diameter
  const scale  = Math.max(1, Math.floor(size * 0.5 / letterH));
  const lW     = letterW * scale;
  const lH     = letterH * scale;
  const lLeft  = Math.round((size - lW) / 2);
  const lTop   = Math.round((size - lH) / 2);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx  = (py * size + px) * 4;
      const dx   = px - cx;
      const dy   = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > radius) {
        // Transparent outside circle
        pixels[idx + 3] = 0;
        continue;
      }

      // Default: red circle
      pixels[idx]     = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;

      // Check if pixel is inside the "N" glyph
      const relX = px - lLeft;
      const relY = py - lTop;
      if (relX >= 0 && relX < lW && relY >= 0 && relY < lH) {
        const col = Math.floor(relX / scale);
        const row = Math.floor(relY / scale);
        if (NBMP[row] && NBMP[row][col] === 1) {
          pixels[idx]     = 255;
          pixels[idx + 1] = 255;
          pixels[idx + 2] = 255;
          pixels[idx + 3] = 255;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Step 2: encode as PNG (RGBA, 8-bit, filter type 0 = None per row)
  // ------------------------------------------------------------------
  const rowBytes = 1 + size * 4; // filter byte + RGBA per pixel
  const raw      = Buffer.alloc(size * rowBytes);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const src  = (y * size + x) * 4;
      const dst  = y * rowBytes + 1 + x * 4;
      raw[dst]     = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  // IHDR: width(4) height(4) bitDepth(1) colorType(1=RGBA=6) compression(1) filter(1) interlace(1)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    PNG_SIG,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------
// Main: generate all three icon sizes
// ------------------------------------------------------------------
const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

[16, 48, 128].forEach(size => {
  const buf  = createIconPNG(size);
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, buf);
  console.log(`✓  Created ${file}  (${buf.length} bytes)`);
});

console.log('\nDone! Icons are in extension/icons/');
console.log('Now load the extension in Chrome:');
console.log('  1. Go to chrome://extensions');
console.log('  2. Enable Developer Mode (top-right toggle)');
console.log('  3. Click "Load unpacked" → select the extension/ folder');
