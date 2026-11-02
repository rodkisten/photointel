/* Deterministic PhotoIntel PNG assets, using Node built-ins only. */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const output = fileURLToPath(new URL('../public/', import.meta.url));
mkdirSync(output, { recursive: true });

const table = Array.from({ length: 256 }, (_, value) => {
  let c = value;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function writePng(name, width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    pixels.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  writeFileSync(join(output, name), Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const circle = (x, y, cx, cy, radius) => Math.hypot(x - cx, y - cy) - radius;
function rounded(x, y, cx, cy, hx, hy, radius) {
  const qx = Math.abs(x - cx) - (hx - radius);
  const qy = Math.abs(y - cy) - (hy - radius);
  return Math.hypot(Math.max(0, qx), Math.max(0, qy)) + Math.min(Math.max(qx, qy), 0) - radius;
}
function mix(from, to, t) {
  return from.map((value, index) => Math.round(value * (1 - t) + to[index] * t));
}
function drawPixel(pixels, offset, color) {
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}
function compose(width, height, variant = 'icon') {
  const splash = variant === 'splash';
  const negative = variant === 'negative';
  const maskable = variant === 'maskable';
  const scale = splash ? Math.min(width * 0.69, height * 0.32) : width * (maskable ? 0.72 : 1);
  const centerX = width / 2;
  const centerY = splash ? height * 0.445 : height / 2;
  const pixels = Buffer.alloc(width * height * 4);
  const edge = 1 / Math.max(scale, 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5 - centerX) / scale + 0.5;
      const v = (y + 0.5 - centerY) / scale + 0.5;
      let color = negative ? [0, 0, 0, 0] : [9, 11, 16, 255];
      // A union of cloud lobes creates the storage silhouette.
      const cloud = Math.min(
        circle(u, v, 0.29, 0.555, 0.164),
        circle(u, v, 0.50, 0.415, 0.238),
        circle(u, v, 0.705, 0.548, 0.165),
        rounded(u, v, 0.50, 0.612, 0.352, 0.138, 0.102),
      );
      if (cloud <= edge) {
        if (negative) {
          if (cloud >= -0.024 - edge) color = [255, 255, 255, 255];
        } else {
          color = [18, 23, 35, 255];
          if (cloud >= -0.025) {
            const hue = clamp((u - 0.17) / 0.67);
            color = mix([205, 192, 248, 255], [113, 208, 224, 255], hue);
          }
        }
      }
      // Image frame, warm photographic content, subtle mountain silhouettes.
      const frame = rounded(u, v, 0.5, 0.557, 0.203, 0.145, 0.035);
      if (frame <= 0) {
        if (negative) {
          if (frame >= -0.014) color = [255, 255, 255, 255];
        } else {
          color = [18, 22, 36, 255];
          if (circle(u, v, 0.397, 0.525, 0.019) <= 0) color = [225, 210, 253, 255];
          const hill = Math.min(
            0.648 - v + Math.abs(u - 0.495) * -0.68,
            0.68 - v + Math.abs(u - 0.588) * -0.90,
          );
          if (hill <= 0) color = mix([111, 112, 187, 255], [188, 170, 233, 255], clamp((0.68 - v) * 3));
          if (frame >= -0.014) color = [237, 235, 252, 255];
        }
      }
      // Faceted insight sparkle and connected analysis dots.
      const dx = Math.abs(u - 0.708) / 0.046;
      const dy = Math.abs(v - 0.367) / 0.065;
      if (dx + dy <= 1) color = negative ? [255, 255, 255, 255] : [247, 245, 255, 255];
      for (const [cx, cy, radius, shade] of [
        [0.753, 0.255, 0.014, [124, 221, 227, 255]],
        [0.830, 0.356, 0.012, [168, 167, 248, 255]],
      ]) {
        if (circle(u, v, cx, cy, radius) <= 0) {
          color = negative ? [255, 255, 255, 255] : shade;
        }
      }
      drawPixel(pixels, (y * width + x) * 4, color);
    }
  }
  return pixels;
}
const jobs = [
  ['icon-192.png', 192, 192, 'icon'],
  ['icon-512.png', 512, 512, 'icon'],
  ['icon-1024.png', 1024, 1024, 'icon'],
  ['icon-maskable-512.png', 512, 512, 'maskable'],
  ['icon-negative-512.png', 512, 512, 'negative'],
  ['apple-touch-icon.png', 180, 180, 'icon'],
  ['splash-1125x2436.png', 1125, 2436, 'splash'],
  ['splash-1170x2532.png', 1170, 2532, 'splash'],
  ['splash-1179x2556.png', 1179, 2556, 'splash'],
  ['splash-1206x2622.png', 1206, 2622, 'splash'],
  ['splash-1290x2796.png', 1290, 2796, 'splash'],
  ['splash-1320x2868.png', 1320, 2868, 'splash'],
];
for (const [name, width, height, variant] of jobs) {
  writePng(name, width, height, compose(width, height, variant));
  console.info('Generated', name);
}
