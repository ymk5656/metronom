const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(len + 12);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, 'ascii');
  data.copy(buf, 8);
  const typeAndData = buf.subarray(4, len + 8);
  const crc = crc32(typeAndData);
  buf.writeUInt32BE(crc, len + 8);
  return buf;
}

function generateMetronomePng(size, outputPath) {
  // Render a clean metronome icon raster
  const width = size;
  const height = size;
  const rawData = Buffer.alloc(height * (1 + width * 4));

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const nx = (x / width) * 2 - 1;
      const ny = (y / height) * 2 - 1;

      // Dark rounded background
      const cornerDist = Math.max(Math.abs(nx), Math.abs(ny));
      let r = 26, g = 26, b = 28, a = 255;

      // Outer metronome pyramid shape
      // Apex at y = -0.7, base at y = 0.5
      // top width = 0.25, bottom width = 0.75
      if (ny >= -0.7 && ny <= 0.65) {
        const t = (ny - (-0.7)) / (0.65 - (-0.7));
        const halfWidth = 0.15 + t * 0.35;
        if (Math.abs(nx) <= halfWidth) {
          // Inside metronome
          r = 38; g = 38; b = 42;
          // Inner brass plate:
          if (ny >= -0.55 && ny <= 0.25) {
            const bt = (ny - (-0.55)) / (0.25 - (-0.55));
            const bHalfWidth = 0.08 + bt * 0.22;
            if (Math.abs(nx) <= bHalfWidth) {
              // Brass gradient
              r = 218 - Math.floor(bt * 40);
              g = 180 - Math.floor(bt * 35);
              b = 85 - Math.floor(bt * 20);

              // Center rod
              if (Math.abs(nx) <= 0.015) {
                r = 230; g = 230; b = 235;
              }
              // Brass weight around ny = -0.15
              if (Math.abs(ny - (-0.15)) <= 0.06 && Math.abs(nx) <= 0.05) {
                r = 245; g = 210; b = 110;
              }
            }
          }

          // Lower front shield
          if (ny >= 0.22 && ny <= 0.65) {
            // Chamfered corners
            const baseHalfWidth = 0.46;
            const topChamferCut = (0.32 - ny) / 0.10;
            const effectiveWidth = ny < 0.32 ? (baseHalfWidth - Math.max(0, topChamferCut * 0.12)) : baseHalfWidth;
            if (Math.abs(nx) <= effectiveWidth) {
              r = 22; g = 22; b = 24;
              // Gold text accent line
              if (Math.abs(ny - 0.42) <= 0.015 && Math.abs(nx) <= 0.2) {
                r = 210; g = 175; b = 80;
              }
              // Digital readout box
              if (Math.abs(ny - 0.54) <= 0.03 && Math.abs(nx) <= 0.14) {
                r = 0; g = 220; b = 180;
              }
            }
          }
        }
      }

      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8 bits per channel
  ihdrData[9] = 6; // Color type 6 (RGBA)
  ihdrData[10] = 0; // Compression
  ihdrData[11] = 0; // Filter
  ihdrData[12] = 0; // Interlace
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressedData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  const png = Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
  fs.writeFileSync(outputPath, png);
  console.log(`Generated ${outputPath} (${width}x${height})`);
}

generateMetronomePng(192, path.join(__dirname, 'public', 'icon-192.png'));
generateMetronomePng(512, path.join(__dirname, 'public', 'icon-512.png'));
