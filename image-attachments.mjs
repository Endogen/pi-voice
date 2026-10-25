import { fail } from './transport.mjs';

// Shared transport limits; build.mjs also embeds these in the browser bundle.
export const imageLimits = Object.freeze({
  maxCount: 4,
  maxImageBytes: 3 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxRequestBytes: 12 * 1024 * 1024,
  maxOriginalBytes: 15 * 1024 * 1024,
  maxEdge: 2048,
  maxPixels: 40_000_000,
});

// This checks the transport envelope and file signature, not a full image decode.
// The browser decodes/re-encodes selections; Pi performs its own image processing.
export function validateImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > imageLimits.maxCount) {
    throw fail(400, `Attach at most ${imageLimits.maxCount} images per message.`);
  }
  let total = 0;
  return value.map((image) => {
    if (!image || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) {
      throw fail(415, 'Use JPEG, PNG or WebP images. SVG, GIF and HEIC are not supported.');
    }
    const { data, mimeType } = image;
    if (typeof data !== 'string' || !data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw fail(400, 'Image data must be valid base64, without a data URL prefix.');
    }
    if (data.length > Math.ceil(imageLimits.maxImageBytes / 3) * 4) throw fail(413, 'Each prepared image must be at most 3 MiB.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data) throw fail(400, 'Image data must be canonical base64.');
    total += bytes.length;
    if (bytes.length > imageLimits.maxImageBytes || total > imageLimits.maxTotalBytes) {
      throw fail(413, 'Images exceed the 3 MiB each / 8 MiB total limit.');
    }
    const matches = mimeType === 'image/jpeg'
      ? bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
      : mimeType === 'image/png'
        ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR'
        : bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!matches) throw fail(400, 'Image bytes do not match the declared image type.');
    return { type: 'image', mimeType, data };
  });
}
