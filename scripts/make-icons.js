'use strict';

/**
 * PWA 아이콘(PNG) 생성.
 *
 * 외부 이미지 라이브러리를 쓰지 않으려고 zlib만으로 PNG를 직접 쓴다.
 * 아이콘은 파란 원 위에 흰 'P'(주차) 한 글자다.
 *
 *   node scripts/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** RGBA 픽셀 버퍼를 PNG 파일 버퍼로 만든다. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // 필터 타입 None
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 'P' 자를 8×10 격자 비트맵으로 그린다. */
const GLYPH_P = [
  '11111100',
  '11111110',
  '11000111',
  '11000111',
  '11000111',
  '11111110',
  '11111100',
  '11000000',
  '11000000',
  '11000000',
];

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size * 0.5;

  const put = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    // 알파 합성. 배경 위에 글자를 얹을 때 가장자리가 튀지 않게 한다.
    const src = a / 255;
    const dstA = rgba[i + 3] / 255;
    const outA = src + dstA * (1 - src);
    if (outA === 0) return;
    rgba[i] = Math.round((r * src + rgba[i] * dstA * (1 - src)) / outA);
    rgba[i + 1] = Math.round((g * src + rgba[i + 1] * dstA * (1 - src)) / outA);
    rgba[i + 2] = Math.round((b * src + rgba[i + 2] * dstA * (1 - src)) / outA);
    rgba[i + 3] = Math.round(outA * 255);
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      // 경계 1px을 부드럽게 처리해 계단 현상을 줄인다.
      const alpha = Math.max(0, Math.min(1, radius - distance)) * 255;
      if (alpha > 0) put(x, y, 0x25, 0x63, 0xeb, alpha);
    }
  }

  const glyphWidth = GLYPH_P[0].length;
  const glyphHeight = GLYPH_P.length;
  const scale = Math.floor((size * 0.52) / glyphHeight);
  const offsetX = Math.round((size - glyphWidth * scale) / 2);
  const offsetY = Math.round((size - glyphHeight * scale) / 2);

  for (let gy = 0; gy < glyphHeight; gy += 1) {
    for (let gx = 0; gx < glyphWidth; gx += 1) {
      if (GLYPH_P[gy][gx] !== '1') continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const x = offsetX + gx * scale + dx;
          const y = offsetY + gy * scale + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) put(x, y, 255, 255, 255, 255);
        }
      }
    }
  }

  return encodePng(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  console.log(`생성: ${path.relative(process.cwd(), file)}`);
}
