type FinalVideoArgs = {
  rawFile: string;
  audioFile: string | null;
  logoFile: string;
  outputFile: string;
  durationSeconds: number;
  overlayLogo: boolean;
};

type MontageArgs = {
  shotFiles: [string, string];
  logoFile: string;
  outputFile: string;
  durationSeconds: number;
  overlayLogo: boolean;
};

export function makeFinalVideoArgs(input: FinalVideoArgs) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input.rawFile];
  if (input.audioFile) args.push('-stream_loop', '-1', '-i', input.audioFile);
  if (input.overlayLogo) args.push('-i', input.logoFile);

  if (!input.overlayLogo) args.push('-map', '0:v:0', '-c:v', 'copy');
  else {
    const logoIndex = input.audioFile ? 2 : 1;
    args.push(
      '-filter_complex',
      `[${logoIndex}:v:0][0:v:0]scale2ref=w=main_w*0.14:h=-1[logo][base];[base][logo]overlay=x=main_w*0.04:y=main_h*0.04:eof_action=repeat[vout]`,
      '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    );
  }

  if (input.audioFile) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  args.push('-t', String(input.durationSeconds), '-movflags', '+faststart', input.outputFile);
  return args;
}

export function makeShotMontageArgs(input: MontageArgs) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input.shotFiles[0], '-i', input.shotFiles[1]];
  if (input.overlayLogo) args.push('-i', input.logoFile);
  const concat = `[0:v:0][1:v:0]concat=n=2:v=1:a=0${input.overlayLogo ? '[base]' : '[vout]'}`;
  if (input.overlayLogo) {
    args.push(
      '-filter_complex',
      `${concat};[2:v:0][base]scale2ref=w=main_w*0.14:h=-1[logo][video];[video][logo]overlay=x=main_w*0.04:y=main_h*0.04:eof_action=repeat[vout]`,
      '-map', '[vout]',
    );
  } else args.push('-filter_complex', concat, '-map', '[vout]');
  args.push('-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', String(input.durationSeconds), input.outputFile);
  return args;
}

/** Older versions without the setting inherit the new default: logo enabled. */
export function shouldOverlayLogo(briefJson: unknown) {
  return !briefJson || typeof briefJson !== 'object' || !('overlayLogo' in briefJson) || briefJson.overlayLogo !== false;
}
