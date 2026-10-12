import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { makeFinalVideoArgs, makeShotMontageArgs, shouldOverlayLogo } from './ffmpeg-args';

describe('FFmpeg final video arguments', () => {
  it('overlays the RIMCO logo at the upper left and keeps the requested duration', () => {
    const args = makeFinalVideoArgs({ rawFile: '/tmp/raw.mp4', logoFile: '/app/public/brand/logo-rimco.png', outputFile: '/tmp/final.mp4', durationSeconds: 15, overlayLogo: true, audioFile: null });
    expect(args).toContain('/app/public/brand/logo-rimco.png');
    expect(args).toContain('-loop');
    expect(args).toContain('1');
    expect(args).toContain('[1:v:0][0:v:0]scale2ref=w=main_w*0.14:h=-1[logo][base];[base][logo]overlay=x=main_w*0.04:y=main_h*0.04:eof_action=repeat[vout]');
    expect(args).toContain('libx264');
    expect(args).toContain('15');
    expect(args).toContain('[vout]');
    expect(args).toContain('-loop');
    expect(args).toContain('-an');
  });

  it('does not add a logo or re-encode video when disabled and no audio is selected', () => {
    const args = makeFinalVideoArgs({ rawFile: '/tmp/raw.mp4', logoFile: '/app/logo.png', outputFile: '/tmp/final.mp4', durationSeconds: 5, overlayLogo: false, audioFile: null });
    expect(args).not.toContain('/app/logo.png');
    expect(args).toContain('copy');
    expect(args).not.toContain('-filter_complex');
  });

  it('keeps selected audio when overlaying the logo', () => {
    const args = makeFinalVideoArgs({ rawFile: '/tmp/raw.mp4', logoFile: '/app/logo.png', outputFile: '/tmp/final.mp4', durationSeconds: 10, overlayLogo: true, audioFile: '/tmp/music.mp3' });
    expect(args).toContain('-stream_loop');
    expect(args).toContain('/tmp/music.mp3');
    expect(args).toContain('[2:v:0][0:v:0]scale2ref=w=main_w*0.14:h=-1[logo][base];[base][logo]overlay=x=main_w*0.04:y=main_h*0.04:eof_action=repeat[vout]');
    expect(args).toContain('1:a:0');
  });

  it('keeps the original video stream when the logo is disabled but audio is selected', () => {
    const args = makeFinalVideoArgs({ rawFile: '/tmp/raw.mp4', logoFile: '/app/logo.png', outputFile: '/tmp/final.mp4', durationSeconds: 10, overlayLogo: false, audioFile: '/tmp/music.mp3' });
    expect(args).not.toContain('/app/logo.png');
    expect(args).toContain('copy');
    expect(args).toContain('1:a:0');
  });

  it('adds the logo after joining both storyboard clips', () => {
    const args = makeShotMontageArgs({ shotFiles: ['/tmp/one.mp4', '/tmp/two.mp4'], logoFile: '/app/logo.png', outputFile: '/tmp/montage.mp4', overlayLogo: true, durationSeconds: 6 });
    expect(args).toContain('[0:v:0][1:v:0]concat=n=2:v=1:a=0[base];[2:v:0][base]scale2ref=w=main_w*0.14:h=-1[logo][video];[video][logo]overlay=x=main_w*0.04:y=main_h*0.04:eof_action=repeat[vout]');
    expect(args).toContain('[vout]');
    expect(args).toContain('6');
  });

  it('joins storyboard clips without adding the logo when disabled', () => {
    const args = makeShotMontageArgs({ shotFiles: ['/tmp/one.mp4', '/tmp/two.mp4'], logoFile: '/app/logo.png', outputFile: '/tmp/montage.mp4', overlayLogo: false, durationSeconds: 6 });
    expect(args).not.toContain('/app/logo.png');
    expect(args.join(' ')).not.toContain('overlay=');
    expect(args).toContain('[vout]');
  });
});

describe('logo preference persistence', () => {
  it('enables the logo by default and respects an explicit opt-out for saved versions', () => {
    expect(shouldOverlayLogo({})).toBe(true);
    expect(shouldOverlayLogo({ overlayLogo: true })).toBe(true);
    expect(shouldOverlayLogo({ overlayLogo: false })).toBe(false);
  });
});

describe('FFmpeg logo rendering', () => {
  it('renders all supported aspect ratios with and without the logo, preserving optional audio', async () => {
    const executable = ffmpegPath;
    if (!executable) throw new Error('Le binaire FFmpeg de test est indisponible.');
    const directory = await mkdtemp(join(tmpdir(), 'rimco-logo-test-'));
    const dimensions: Array<[number, number]> = [[320, 180], [180, 320], [240, 240], [200, 250]];
    const run = (args: string[]) => {
      const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000 });
      if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg a échoué pendant le test de rendu.');
    };
    try {
      const audioFile = join(directory, 'music.wav');
      // Keep synthetic sources long enough for FFmpeg's Linux encoder to emit
      // packets consistently (sub-second MP4s can be header-only on some builds).
      run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'pcm_s16le', audioFile]);
      for (const [index, [width, height]] of dimensions.entries()) {
        const rawFile = join(directory, `raw-${index}.mp4`);
        const overlaidFile = join(directory, `logo-${index}.mp4`);
        const plainFile = join(directory, `plain-${index}.mp4`);
        run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x334455:s=${width}x${height}:r=24:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rawFile]);
        run(makeFinalVideoArgs({ rawFile, logoFile: join(process.cwd(), 'public/brand/logo-rimco.png'), outputFile: overlaidFile, durationSeconds: 2, overlayLogo: true, audioFile: index === 0 ? audioFile : null }));
        run(makeFinalVideoArgs({ rawFile, logoFile: join(process.cwd(), 'public/brand/logo-rimco.png'), outputFile: plainFile, durationSeconds: 2, overlayLogo: false, audioFile: null }));
        expect((await stat(overlaidFile)).size).toBeGreaterThan(0);
        expect((await stat(plainFile)).size).toBeGreaterThan(0);
        run(['-hide_banner', '-loglevel', 'error', '-i', overlaidFile, '-f', 'null', '-']);
        run(['-hide_banner', '-loglevel', 'error', '-i', plainFile, '-f', 'null', '-']);
        if (index === 0) run(['-hide_banner', '-loglevel', 'error', '-i', overlaidFile, '-map', '0:a:0', '-f', 'null', '-']);
      }

      const montageFile = join(directory, 'montage.mp4');
      run(makeShotMontageArgs({ shotFiles: [join(directory, 'raw-0.mp4'), join(directory, 'raw-0.mp4')], logoFile: join(process.cwd(), 'public/brand/logo-rimco.png'), outputFile: montageFile, overlayLogo: true, durationSeconds: 4 }));
      run(['-hide_banner', '-loglevel', 'error', '-i', montageFile, '-f', 'null', '-']);
      expect((await stat(montageFile)).size).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
