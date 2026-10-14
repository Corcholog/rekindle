import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

function createPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  // 1. Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // 2. IHDR Chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth 8
  ihdrData.writeUInt8(6, 9); // color type 6: RGBA
  ihdrData.writeUInt8(0, 10); // compression method 0
  ihdrData.writeUInt8(0, 11); // filter method 0
  ihdrData.writeUInt8(0, 12); // interlace method 0

  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // 3. Raw image scanlines
  // Each scanline begins with a filter byte (0 = None) followed by width * 4 bytes (RGBA)
  const scanlineLength = 1 + width * 4;
  const rawData = Buffer.alloc(scanlineLength * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength;
    rawData.writeUInt8(0, rowOffset); // filter = None

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      // Draw rounded icon border & central loom weave pattern
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height / 2) / (height / 2);
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Background rounded pill
      if (Math.abs(dx) < 0.85 && Math.abs(dy) < 0.85) {
        // Grid pattern
        const isGridLine = (Math.abs(x - width * 0.35) < Math.max(1, width * 0.08)) ||
                           (Math.abs(x - width * 0.65) < Math.max(1, width * 0.08)) ||
                           (Math.abs(y - height * 0.35) < Math.max(1, height * 0.08)) ||
                           (Math.abs(y - height * 0.65) < Math.max(1, height * 0.08));

        if (isGridLine) {
          // Bright gold / amber
          rawData.writeUInt8(251, pxOffset);     // R: 251
          rawData.writeUInt8(191, pxOffset + 1); // G: 191
          rawData.writeUInt8(36, pxOffset + 2);  // B: 36
          rawData.writeUInt8(255, pxOffset + 3); // A: 255
        } else {
          // Dark background #18181b
          rawData.writeUInt8(24, pxOffset);
          rawData.writeUInt8(24, pxOffset + 1);
          rawData.writeUInt8(27, pxOffset + 2);
          rawData.writeUInt8(240, pxOffset + 3);
        }
      } else {
        // Transparent outside
        rawData.writeUInt8(0, pxOffset);
        rawData.writeUInt8(0, pxOffset + 1);
        rawData.writeUInt8(0, pxOffset + 2);
        rawData.writeUInt8(0, pxOffset + 3);
      }
    }
  }

  // 4. IDAT Chunk (Compressed scanlines)
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);

  // 5. IEND Chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = data.length;
  const chunk = Buffer.alloc(8 + len + 4);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);

  const crc = crc32(chunk.subarray(4, 8 + len));
  chunk.writeUInt32BE(crc, 8 + len);
  return chunk;
}

// CRC32 table
const crcTable: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function main() {
  const iconsDir = path.resolve(__dirname, '../extension/icons');
  await fs.promises.mkdir(iconsDir, { recursive: true });

  const sizes = [16, 48, 128];
  for (const s of sizes) {
    const png = createPng(s, s, 245, 158, 11);
    const filePath = path.join(iconsDir, `icon-${s}.png`);
    await fs.promises.writeFile(filePath, png);
    console.log(`Generated ${filePath} (${png.length} bytes)`);
  }
}

main().catch(console.error);
