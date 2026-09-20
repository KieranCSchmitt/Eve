import { ImportError } from './filesystem';

export const ASSET_LIMITS = Object.freeze({ textBytes: 8 * 1024 * 1024, imageBytes: 32 * 1024 * 1024, imagePixels: 40_000_000, imageDimension: 16_384 });
export const ASSET_TYPES: Readonly<Record<string, { mediaType: string; text: boolean; extension: string }>> = Object.freeze({
  '.txt': { mediaType: 'text/plain', text: true, extension: '.txt' },
  '.md': { mediaType: 'text/markdown', text: true, extension: '.md' },
  '.markdown': { mediaType: 'text/markdown', text: true, extension: '.md' },
  '.png': { mediaType: 'image/png', text: false, extension: '.png' },
  '.jpg': { mediaType: 'image/jpeg', text: false, extension: '.jpg' },
  '.jpeg': { mediaType: 'image/jpeg', text: false, extension: '.jpg' },
  '.webp': { mediaType: 'image/webp', text: false, extension: '.webp' },
});

/** Header validation bounds accepted raster dimensions; decoding remains sandboxed in the viewer. */
export function validateImage(header: Buffer, mediaType: string, size: number) {
  const invalid = () => new ImportError('UNSUPPORTED_TYPE', 'The image header does not match a supported raster format.');
  let width = 0; let height = 0;
  if (mediaType === 'image/png') {
    if (header.length < 33 || !header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR') throw invalid();
    width = header.readUInt32BE(16); height = header.readUInt32BE(20);
  } else if (mediaType === 'image/jpeg') {
    if (header.length < 4 || header[0] !== 0xff || header[1] !== 0xd8) throw invalid();
    let offset = 2;
    while (offset + 3 < header.length) {
      if (header[offset++] !== 0xff) throw invalid();
      while (header[offset] === 0xff) offset++;
      const marker = header[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > header.length) break;
      const length = header.readUInt16BE(offset);
      if (length < 2 || offset + length > header.length) throw invalid();
      if ([0xc0,0xc1,0xc2].includes(marker)) {
        if (length < 8) throw invalid();
        height = header.readUInt16BE(offset + 3); width = header.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (mediaType === 'image/webp') {
    if (header.length < 30 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WEBP' || header.readUInt32LE(4) + 8 !== size) throw invalid();
    const kind = header.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      if (header[20] & 0x02) throw new ImportError('UNSUPPORTED_TYPE', 'Animated WebP is not supported by the image importer.');
      width = header.readUIntLE(24, 3) + 1; height = header.readUIntLE(27, 3) + 1;
    } else if (kind === 'VP8 ' && header.subarray(23,26).equals(Buffer.from([0x9d,0x01,0x2a]))) {
      width = header.readUInt16LE(26) & 0x3fff; height = header.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && header[20] === 0x2f) {
      const bits = header.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height) throw invalid();
  if (width > ASSET_LIMITS.imageDimension || height > ASSET_LIMITS.imageDimension || width * height > ASSET_LIMITS.imagePixels) throw new ImportError('TOO_LARGE', 'This image exceeds the supported pixel dimensions.');
}
