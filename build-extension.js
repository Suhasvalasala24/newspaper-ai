/**
 * NewsAI — Extension Build Script
 * Copies widget files into the extension/ folder so Chrome can load them.
 * Run once before loading the extension: node build-extension.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
const EXT  = path.join(ROOT, 'extension');

// Files to copy: [source, destination]
const COPIES = [
  ['widget/newsai-widget.js',         'extension/widget/newsai-widget.js'],
  ['widget/newsai-widget.css',        'extension/widget/newsai-widget.css'],
  ['widget/newsai-config-loader.js',  'extension/widget/newsai-config-loader.js'],
  ['widget/newsai-content.js',        'extension/widget/newsai-content.js'],
  ['configs/eenadu.json',             'extension/configs/eenadu.json'],
];

// Ensure directories exist
['extension/widget', 'extension/configs', 'extension/icons'].forEach(dir => {
  fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
});

// Copy files
let ok = 0;
for (const [src, dest] of COPIES) {
  const srcPath  = path.join(ROOT, src);
  const destPath = path.join(ROOT, dest);
  try {
    fs.copyFileSync(srcPath, destPath);
    console.log(`✅ Copied: ${src} → ${dest}`);
    ok++;
  } catch (err) {
    console.error(`❌ Failed: ${src} — ${err.message}`);
  }
}

// Generate simple PNG icons using raw PNG binary (no external deps)
console.log('\n📸 Generating icons...');
generateIcons();

console.log(`\n✅ Build complete — ${ok}/${COPIES.length} files copied.`);
console.log('📂 Now load the extension/  folder in Chrome:');
console.log('   chrome://extensions → Developer Mode ON → Load unpacked → select extension/');

// ── Minimal PNG generator (no external packages) ──────────────────────────
// Creates a valid PNG file with a colored circle and letter using raw bytes.
function generateIcons() {
  const sizes = [16, 48, 128];
  const zlib  = require('zlib');

  for (const size of sizes) {
    const iconPath = path.join(ROOT, 'extension', 'icons', `icon${size}.png`);
    if (fs.existsSync(iconPath)) {
      console.log(`  ⏭ Skipped icon${size}.png (already exists)`);
      continue;
    }
    try {
      const png = makePng(size);
      fs.writeFileSync(iconPath, png);
      console.log(`  ✅ Generated icon${size}.png`);
    } catch (err) {
      console.warn(`  ⚠️  Could not generate icon${size}.png: ${err.message}`);
      console.warn('     Open extension/generate-icons.html in Chrome as a fallback.');
    }
  }
}

function makePng(size) {
  const zlib = require('zlib');
  // Build RGBA pixel data for each row
  const rows = [];
  const cx = size / 2, cy = size / 2, r = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        // Red circle (#C0392B)
        row.push(0xC0, 0x39, 0x2B, 255);
      } else {
        // Transparent
        row.push(0, 0, 0, 0);
      }
    }
    rows.push(row);
  }

  // Add letter "N" pixels (simplified — just draw on mid-sizes)
  if (size >= 16) {
    drawLetter(rows, size, 0xFF, 0xFF, 0xFF);
  }

  // Build PNG binary
  const png = buildPNG(rows, size, size);
  return png;
}

function drawLetter(rows, size, r, g, b) {
  // Draw a simple "N" pattern
  const s = Math.max(1, Math.floor(size * 0.12));  // stroke width
  const pad = Math.floor(size * 0.25);
  const top = Math.floor(size * 0.2);
  const bot = Math.floor(size * 0.8);
  const left = Math.floor(size * 0.28);
  const right = Math.floor(size * 0.72);

  function dot(x, y) {
    for (let dy = 0; dy < s; dy++) {
      for (let dx = 0; dx < s; dx++) {
        const px = x + dx, py = y + dy;
        if (px >= 0 && px < size && py >= 0 && py < size) {
          rows[py][px * 4]     = r;
          rows[py][px * 4 + 1] = g;
          rows[py][px * 4 + 2] = b;
          rows[py][px * 4 + 3] = 255;
        }
      }
    }
  }

  // Left vertical
  for (let y = top; y < bot; y++) dot(left, y);
  // Right vertical
  for (let y = top; y < bot; y++) dot(right, y);
  // Diagonal
  const steps = bot - top;
  for (let i = 0; i < steps; i++) {
    const x = left + Math.floor((right - left) * i / steps);
    dot(x, top + i);
  }
}

function buildPNG(rows, width, height) {
  const zlib = require('zlib');

  // Raw image data: filter byte (0) + RGBA row
  const rawData = Buffer.alloc((1 + width * 4) * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (1 + width * 4);
    rawData[offset] = 0; // None filter
    for (let x = 0; x < width; x++) {
      const src = x * 4;
      const dst = offset + 1 + x * 4;
      rawData[dst]     = rows[y][src];
      rawData[dst + 1] = rows[y][src + 1];
      rawData[dst + 2] = rows[y][src + 2];
      rawData[dst + 3] = rows[y][src + 3];
    }
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    })());
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
