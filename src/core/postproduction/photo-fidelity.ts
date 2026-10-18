import { inflateSync } from 'node:zlib';

/** PNG signature + IHDR color type 4 (gray/alpha) or 6 (RGBA). */
export function hasPngAlphaChannel(bytes: Buffer): boolean {
  return bytes.length >= 26
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes[24] === 8
    && (bytes[25] === 4 || bytes[25] === 6);
}

/** Accept only a non-interlaced 8-bit PNG with both transparent and visible pixels. */
export function hasTransparentPngPixels(bytes: Buffer): boolean {
  if (!hasPngAlphaChannel(bytes)) return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  const bytesPerPixel = colorType === 6 ? 4 : 2;
  const alphaOffset = colorType === 6 ? 3 : 1;
  const interlace = bytes[28];
  if (!width || !height || width > 12000 || height > 12000 || interlace !== 0) return false;
  const rowLength = width * bytesPerPixel;
  const decodedSize = (rowLength + 1) * height;
  if (decodedSize > 128 * 1024 * 1024) return false;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const name = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) return false;
    if (name === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (name === 'IEND') break;
  }
  if (!chunks.length) return false;
  let decoded: Buffer;
  try { decoded = inflateSync(Buffer.concat(chunks), { maxOutputLength: decodedSize }); }
  catch { return false; }
  if (decoded.length !== decodedSize) return false;

  let previous = Buffer.alloc(rowLength);
  let hasTransparent = false;
  let hasVisible = false;
  for (let y = 0; y < height; y += 1) {
    const start = y * (rowLength + 1);
    const filter = decoded[start];
    const row = Buffer.from(decoded.subarray(start + 1, start + 1 + rowLength));
    if (filter > 4) return false;
    for (let x = 0; x < rowLength; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0;
      row[x] = (row[x] + predictor) & 0xff;
    }
    for (let x = alphaOffset; x < rowLength; x += bytesPerPixel) {
      if (row[x] < 255) hasTransparent = true;
      if (row[x] > 0) hasVisible = true;
    }
    if (hasTransparent && hasVisible) return true;
    previous = row;
  }
  return false;
}

function paeth(left: number, above: number, upperLeft: number) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}
