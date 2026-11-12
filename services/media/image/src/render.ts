import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Format = 'webp' | 'avif' | 'jpeg' | 'png';
export function parseFormat(value: string): Format {
  if (value === 'webp' || value === 'avif' || value === 'jpeg' || value === 'png') return value;
  throw new Error('Unsupported output format');
}
export function parseDimension(value: string | undefined, fallback: number): number {
  const dimension = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096) {
    throw new Error('Dimension must be an integer between 1 and 4096');
  }
  return dimension;
}
export function validateKey(value: string, prefix: string): string {
  if (value.length > 512 || !value.startsWith(prefix) || !/^[a-zA-Z0-9/_ .-]+$/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid object key');
  }
  return value;
}
export async function transform(source: Buffer, format: Format, width: number, height: number): Promise<Buffer> {
  if (source.length > 25 * 1024 * 1024) throw new Error('Image exceeds 25 MiB');
  return sharp(source, { limitInputPixels: 40_000_000, failOn: 'error' })
    .rotate()
    .resize(width, height, { fit: 'inside', withoutEnlargement: true })
    .toFormat(format, { quality: 78 })
    .toBuffer();
}
async function main(): Promise<void> {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('R2 configuration missing');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.r2\.cloudflarestorage\.com$/.test(url.hostname)) {
    throw new Error('Invalid R2 endpoint');
  }
  const input = validateKey(process.env.MEDIA_INPUT_KEY || '', 'originals/');
  const format = parseFormat(process.env.MEDIA_FORMAT || 'webp');
  const output = validateKey(process.env.MEDIA_OUTPUT_KEY || '', 'derived/');
  if (!output.endsWith('.' + format)) throw new Error('Output extension must match format');
  const width = parseDimension(process.env.MEDIA_WIDTH, 1280);
  const height = parseDimension(process.env.MEDIA_HEIGHT, 1280);
  const client = new S3Client({
    region: 'auto', endpoint, forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: input }));
  if (!response.Body) throw new Error('Empty image');
  if (response.ContentLength && response.ContentLength > 25 * 1024 * 1024) {
    throw new Error('Image exceeds 25 MiB');
  }
  const source = Buffer.from(await response.Body.transformToByteArray());
  const result = await transform(source, format, width, height);
  await client.send(new PutObjectCommand({
    Bucket: bucket, Key: output, Body: result,
    ContentType: 'image/' + format, CacheControl: 'private, max-age=31536000, immutable',
  }));
  process.stdout.write(JSON.stringify({ status: 'ok', outputKey: output, bytes: result.length }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
