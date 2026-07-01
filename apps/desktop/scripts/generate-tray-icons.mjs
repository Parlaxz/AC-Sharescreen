import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

function createCirclePixels(size, r, g, b) {
  const data = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const radius = size * 0.38;
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      
      let alpha;
      if (dist <= radius - 0.5) {
        alpha = 255;
      } else if (dist >= radius + 0.5) {
        alpha = 0;
      } else {
        alpha = Math.round(255 * (radius + 0.5 - dist));
      }
      
      if (alpha > 0) {
        const shadow = Math.max(0, 1 - (dist / radius));
        const brightness = 0.85 + 0.15 * shadow;
        data[idx] = Math.min(255, Math.round(r * brightness));
        data[idx + 1] = Math.min(255, Math.round(g * brightness));
        data[idx + 2] = Math.min(255, Math.round(b * brightness));
        data[idx + 3] = alpha;
      } else {
        data[idx] = data[idx + 1] = data[idx + 2] = data[idx + 3] = 0;
      }
    }
  }
  return data;
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBytes, data]);
  const crc = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([length, typeBytes, data, crcBuf]);
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xEDB88320;
      else crc = crc >>> 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function encodePNG(width, height, pixelData) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = createChunk('IHDR', ihdrData);
  
  const rawStride = 1 + width * 4;
  const raw = Buffer.alloc(height * rawStride);
  for (let y = 0; y < height; y++) {
    raw[y * rawStride] = 0;
    pixelData.copy(raw, y * rawStride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw);
  const idat = createChunk('IDAT', compressed);
  const iend = createChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

const colors = [
  { name: 'blue',   r: 59,  g: 130, b: 246 },
  { name: 'green',  r: 34,  g: 197, b: 94 },
  { name: 'orange', r: 249, g: 115, b: 22 },
  { name: 'red',    r: 239, g: 68,  b: 68 },
];

const size = 32;
const assetsDir = path.resolve('apps/desktop/assets');

for (const { name, r, g, b } of colors) {
  const pixels = createCirclePixels(size, r, g, b);
  const png = encodePNG(size, size, pixels);
  const outPath = path.join(assetsDir, `tray-icon-${name}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created ${outPath} (${png.length} bytes)`);
}
