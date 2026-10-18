type FinalVideoArgs = {
  rawFile: string;
  audioFile: string | null;
  logoFile: string;
  outputFile: string;
  durationSeconds: number;
  overlayLogo: boolean;
  format?: VideoFormat;
};

type MontageArgs = {
  shotFiles: [string, string];
  logoFile: string;
  outputFile: string;
  durationSeconds: number;
  overlayLogo: boolean;
  format?: VideoFormat;
};

type MultiClipMontageArgs = {
  shotFiles: string[];
  shotDurations: number[];
  logoFile: string;
  outputFile: string;
  finalDurationSeconds: number;
  clipDurationSeconds?: 5 | 10 | 15 | 20;
  singleStoryboardMode?: boolean;
  qualityCrf?: number;
  format?: VideoFormat;
};

type PhotoFidelityShotArgs = {
  backgroundFile: string;
  vehicleFile?: string;
  outputFile: string;
  durationSeconds: number;
  format?: VideoFormat;
};

export type VideoFormat = '16:9' | '9:16' | '1:1' | '4:5';

const OUTPUT_DIMENSIONS: Record<VideoFormat, [number, number]> = {
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '1:1': [1080, 1080],
  '4:5': [864, 1080],
};

export function normalizeVideoFormat(value: unknown): VideoFormat {
  return value === '9:16' || value === '1:1' || value === '4:5' ? value : '16:9';
}

/** Build one deterministic shot from the original location image and optional alpha vehicle cutout. */
export function makePhotoFidelityShotArgs(input: PhotoFidelityShotArgs) {
  const format = normalizeVideoFormat(input.format);
  const [width, height] = OUTPUT_DIMENSIONS[format];
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', input.backgroundFile];
  let composition = '[0:v:0]scale=' + width + ':' + height + ':force_original_aspect_ratio=increase,crop=' + width + ':' + height + ',setsar=1[background]';
  if (input.vehicleFile) {
    args.push('-loop', '1', '-framerate', '30', '-i', input.vehicleFile);
    composition += `;[1:v:0]format=rgba,scale=${Math.round(width * 0.62)}:${Math.round(height * 0.7)}:force_original_aspect_ratio=decrease[vehicle];[background][vehicle]overlay=x=(W-w)/2:y=(H-h)/2:format=auto:shortest=1[scene]`;
  } else composition += ';[background]copy[scene]';
  composition += `;[scene]zoompan=z='min(zoom+0.00008,1.025)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=30,trim=duration=${input.durationSeconds},setpts=PTS-STARTPTS,format=yuv420p[vout]`;
  args.push('-filter_complex', composition, '-map', '[vout]', '-an', '-t', String(input.durationSeconds), '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', input.outputFile);
  return args;
}

function normalizeVideoFilter(format: VideoFormat, source: string, output: string) {
  const [width, height] = OUTPUT_DIMENSIONS[format];
  return `[${source}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[${output}]`;
}

export function makeFinalVideoArgs(input: FinalVideoArgs) {
  const format = normalizeVideoFormat(input.format);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input.rawFile];
  if (input.audioFile) args.push('-stream_loop', '-1', '-i', input.audioFile);
  if (input.overlayLogo) args.push('-loop', '1', '-i', input.logoFile);

  if (!input.overlayLogo) {
    args.push('-filter_complex', normalizeVideoFilter(format, '0:v:0', 'base'), '-map', '[base]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  }
  else {
    const logoIndex = input.audioFile ? 2 : 1;
    // Taille lisible sans dominer l’image (12 % de la largeur vidéo).
    args.push(
      '-filter_complex',
      `${normalizeVideoFilter(format, '0:v:0', 'normalized')};[${logoIndex}:v:0]format=rgba[logo_rgba];[logo_rgba][normalized]scale2ref=w=main_w*0.12:h=-1[logo][base];[base][logo]overlay=x=main_w*0.035:y=main_h*0.035:format=auto:eof_action=repeat[vout]`,
      '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    );
  }

  if (input.audioFile) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  args.push('-t', String(input.durationSeconds), '-movflags', '+faststart', input.outputFile);
  return args;
}

export function makeShotMontageArgs(input: MontageArgs) {
  const format = normalizeVideoFormat(input.format);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input.shotFiles[0], '-i', input.shotFiles[1]];
  if (input.overlayLogo) args.push('-loop', '1', '-i', input.logoFile);
  const concat = `[0:v:0][1:v:0]concat=n=2:v=1:a=0[concat]`;
  if (input.overlayLogo) {
    // Même échelle pour les montages storyboard afin de garder une identité constante.
    args.push(
      '-filter_complex',
      `${concat};${normalizeVideoFilter(format, 'concat', 'normalized')};[2:v:0]format=rgba[logo_rgba];[logo_rgba][normalized]scale2ref=w=main_w*0.12:h=-1[logo][video];[video][logo]overlay=x=main_w*0.035:y=main_h*0.035:format=auto:eof_action=repeat[vout]`,
      '-map', '[vout]',
    );
  } else args.push('-filter_complex', `${concat};${normalizeVideoFilter(format, 'concat', 'vout')}`, '-map', '[vout]');
  args.push('-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', String(input.durationSeconds), input.outputFile);
  return args;
}

/** Assemble generated footage, then append a distinct two-second animated brand end card. */
export function makeMultiClipMontageArgs(input: MultiClipMontageArgs) {
  if (input.shotFiles.length < (input.singleStoryboardMode ? 1 : 2) || input.shotFiles.length !== input.shotDurations.length) throw new Error('Le montage ne contient pas le nombre attendu de plans.');
  const clipSeconds = input.shotDurations.reduce((sum, seconds) => sum + seconds, 0);
  const hasNewDurationContract = input.clipDurationSeconds !== undefined;
  if (hasNewDurationContract && (![7, 12, 17, 22].includes(input.finalDurationSeconds) || input.finalDurationSeconds !== input.clipDurationSeconds! + 2)) throw new Error('La vidéo finale doit ajouter exactement deux secondes au logo.');
  if (!hasNewDurationContract && ![5, 10, 15, 20, 30].includes(input.finalDurationSeconds)) throw new Error('La durée enregistrée n’est pas prise en charge.');
  const footageSeconds = input.clipDurationSeconds ?? input.finalDurationSeconds - 2;
  if ((input.singleStoryboardMode ? clipSeconds < footageSeconds : clipSeconds !== footageSeconds) || input.shotDurations.some((seconds) => !Number.isInteger(seconds) || seconds <= 0)) throw new Error('Les plans doivent laisser exactement deux secondes au logo final.');
  const format = normalizeVideoFormat(input.format);
  const [width, height] = OUTPUT_DIMENSIONS[format];
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  input.shotFiles.forEach((file) => args.push('-i', file));
  args.push('-loop', '1', '-i', input.logoFile);
  const filters = input.shotFiles.map((_, index) => `[${index}:v:0]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${input.shotDurations[index]},trim=duration=${input.shotDurations[index]},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[v${index}]`);
  filters.push(`${input.shotFiles.map((_, index) => `[v${index}]`).join('')}concat=n=${input.shotFiles.length}:v=1:a=0[footage_all]`);
  filters.push(`[footage_all]trim=duration=${footageSeconds},setpts=PTS-STARTPTS[footage]`);
  filters.push(`color=c=white:s=${width}x${height}:r=30:d=2[card];[${input.shotFiles.length}:v:0]format=rgba,scale=w='iw*(0.9+0.1*min(t/0.6,1))':h=-1:eval=frame[logo];[card][logo]overlay=(W-w)/2:(H-h)/2:format=auto,fade=t=in:st=0:d=0.45,fade=t=out:st=1.55:d=0.45[brand]`);
  filters.push('[footage][brand]concat=n=2:v=1:a=0[vout]');
  const qualityCrf = Number.isInteger(input.qualityCrf) && input.qualityCrf! >= 0 && input.qualityCrf! <= 51 ? input.qualityCrf! : 20;
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(qualityCrf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', String(input.finalDurationSeconds), input.outputFile);
  return args;
}

/** Older versions without the setting inherit the new default: logo enabled. */
export function shouldOverlayLogo(briefJson: unknown) {
  return !briefJson || typeof briefJson !== 'object' || !('overlayLogo' in briefJson) || briefJson.overlayLogo !== false;
}
