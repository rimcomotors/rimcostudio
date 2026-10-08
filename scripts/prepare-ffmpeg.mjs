import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

if (!ffmpegPath) {
  throw new Error('ffmpeg-static n’a pas fourni de binaire pour cette plateforme.');
}

const source = await stat(ffmpegPath);
if (!source.isFile()) {
  throw new Error('Le binaire fourni par ffmpeg-static est introuvable.');
}

const destination = resolve(process.cwd(), '.generated', 'ffmpeg');
await mkdir(dirname(destination), { recursive: true });
await copyFile(ffmpegPath, destination);
await chmod(destination, 0o755);
console.info(`Binaire FFmpeg préparé (${process.platform}/${process.arch}).`);
