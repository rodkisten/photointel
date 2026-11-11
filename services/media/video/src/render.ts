import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9/_ .-]{0,500}$/;
export function validateKey(key: string): string {
  if (!keyPattern.test(key) || key.split('/').some(p => p === '..' || p === '.')) {
    throw new Error('Invalid media object key');
  }
  return key;
}
export function filterGraph(): string {
  return 'scale=720:1280:force_original_aspect_ratio=decrease,' +
    'pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';
}
function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-8192); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg failed: ' + errors)));
  });
}
async function main(): Promise<void> {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const inputKey = validateKey(process.env.MEDIA_INPUT_KEY || '');
  const outputKey = validateKey(process.env.MEDIA_OUTPUT_KEY || '');
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || inputKey === outputKey) {
    throw new Error('Missing R2 configuration or output key equals input key');
  }
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'https:') throw new Error('R2 endpoint must use HTTPS');
  const watermark = (process.env.MEDIA_WATERMARK || '').slice(0, 120);
  const client = new S3Client({
    region: 'auto', endpoint, forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const directory = await mkdtemp(join(tmpdir(), 'photointel-media-'));
  try {
    const source = join(directory, 'source');
    const target = join(directory, 'story.mp4');
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: inputKey }));
    if (!response.Body) throw new Error('Source object is empty');
    const bytes = await (response.Body as Readable).toArray();
    const buffer = Buffer.concat(bytes.map(chunk => Buffer.from(chunk)));
    if (buffer.length > 200 * 1024 * 1024) throw new Error('Source exceeds 200 MiB');
    await writeFile(source, buffer);
    let vf = filterGraph();
    if (watermark) {
      const label = join(directory, 'watermark.txt');
      await writeFile(label, watermark, 'utf8');
      vf += ",drawtext=textfile=" + label + ":fontcolor=white:fontsize=26:" +
        "box=1:boxcolor=black@0.45:boxborderw=10:x=24:y=h-th-40";
    }
    await runFFmpeg([
      '-i', source, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '22',
      '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-movflags', '+faststart', target,
    ]);
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: outputKey, ContentType: 'video/mp4',
      Body: await readFile(target),
    }));
    process.stdout.write(JSON.stringify({ status: 'ok', outputKey }) + '\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.env.NODE_ENV !== 'test') {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
