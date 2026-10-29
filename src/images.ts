import type { ImageType } from './youcam.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // YouCam's own upload limit

export interface Img {
  bytes: Buffer;
  type: ImageType;
  name: string;
}

export class BadRequest extends Error {}

const PREFIXES: Record<string, ImageType> = {
  'data:image/jpeg;base64,': 'image/jpeg',
  'data:image/png;base64,': 'image/png',
};

function looksLike(type: ImageType, b: Buffer): boolean {
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8;
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

// Parse a browser data URL into bytes, checking type, size and the file's own signature.
export function parseDataUrl(value: unknown, label: string): Img {
  if (typeof value !== 'string') throw new BadRequest(`${label} is missing.`);
  const prefix = Object.keys(PREFIXES).find((p) => value.startsWith(p));
  if (!prefix) throw new BadRequest(`${label} must be a JPG or PNG image.`);
  const type = PREFIXES[prefix]!;
  const bytes = Buffer.from(value.slice(prefix.length), 'base64');
  if (bytes.length === 0) throw new BadRequest(`${label} is empty.`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new BadRequest(`${label} is larger than 10 MB.`);
  if (!looksLike(type, bytes)) throw new BadRequest(`${label} is not a valid ${type === 'image/png' ? 'PNG' : 'JPG'}.`);
  return { bytes, type, name: `${label.toLowerCase().replace(/\W+/g, '-')}.${type === 'image/png' ? 'png' : 'jpg'}` };
}

export function toDataUrl(bytes: Buffer, type: ImageType = 'image/jpeg'): string {
  return `data:${type};base64,${bytes.toString('base64')}`;
}
