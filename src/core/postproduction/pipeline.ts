import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';

const ffmpegPath = join(process.cwd(), '.generated', 'ffmpeg');
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

type AdminClient = ReturnType<typeof createStorageAdminClient>;

/** Normalize a provider clip to MP4 and optionally mix a user-selected audio track. */
export async function beginPostproduction(versionId: string) {
  const admin = createStorageAdminClient();
  const { data: version, error } = await admin.from('video_versions')
    .select('id,video_id,raw_path,audio_asset_id,generation_seconds,video:videos!inner(id,user_id,brand_id,department)')
    .eq('id', versionId).single();
  if (error || !version?.raw_path) throw new HttpError(409, 'La vidéo brute est indisponible pour la post-production.');
  const durationSeconds = Number(version.generation_seconds);
  if (![5, 6, 10, 15, 20, 30].includes(durationSeconds)) throw new HttpError(422, 'La durée enregistrée pour cette vidéo n’est pas prise en charge.');
  const video = Array.isArray(version.video) ? version.video[0] : version.video;
  if (!video?.brand_id || !video.user_id) throw new HttpError(409, 'La marque associée à cette vidéo est introuvable.');
  try {
    await access(ffmpegPath, constants.X_OK);
  } catch {
    throw new HttpError(503, 'FFmpeg n’est pas disponible sur ce déploiement.');
  }

  const audio = version.audio_asset_id
    ? (await admin.from('assets').select('path,kind,status,brand_id').eq('id', version.audio_asset_id).maybeSingle()).data
    : null;
  if (audio && (audio.kind !== 'audio' || audio.status !== 'validée' || audio.brand_id !== video.brand_id)) throw new HttpError(422, 'La piste audio sélectionnée n’est pas validée pour cette marque.');

  const [rawBytes, audioBytes] = await Promise.all([
    downloadAsset(admin, 'videos', version.raw_path, MAX_VIDEO_BYTES, 'La vidéo brute'),
    audio ? downloadAsset(admin, 'audio', audio.path, MAX_AUDIO_BYTES, 'La piste audio') : Promise.resolve(null),
  ]);
  validateMp4(rawBytes);

  const directory = await mkdtemp(join(tmpdir(), 'rimco-postprod-'));
  const rawFile = join(directory, 'raw.mp4');
  const audioFile = audioBytes ? join(directory, audio?.path.toLowerCase().endsWith('.wav') ? 'sound.wav' : audio?.path.toLowerCase().endsWith('.m4a') ? 'sound.m4a' : 'sound.mp3') : null;
  const outputFile = join(directory, 'final.mp4');
  try {
    await Promise.all([writeFile(rawFile, rawBytes), ...(audioBytes && audioFile ? [writeFile(audioFile, audioBytes)] : [])]);
    await runFfmpeg(ffmpegPath, makeFfmpegArgs({ rawFile, audioFile, outputFile, durationSeconds }));
    const outputStat = await stat(outputFile);
    if (outputStat.size > MAX_VIDEO_BYTES) throw new HttpError(502, 'Le MP4 final dépasse la taille autorisée.');
    const output = await readFile(outputFile);
    validateMp4(output);

    const finalPath = `${version.video_id}/${versionId}/final.mp4`;
    const { error: uploadError } = await admin.storage.from('videos').upload(finalPath, output, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new HttpError(502, 'Impossible d’enregistrer le MP4 final dans la médiathèque sécurisée.');

    const { data: existingLedger, error: ledgerReadError } = await admin.from('usage_ledger').select('status,cost_usd,cost_eur,price_fcfa').eq('version_id', versionId).eq('kind', 'postprod').maybeSingle();
    if (ledgerReadError) throw new HttpError(503, 'Impossible de vérifier le journal de post-production.');
    if (existingLedger && (existingLedger.status !== 'charged' || Number(existingLedger.cost_usd) !== 0 || Number(existingLedger.cost_eur) !== 0 || Number(existingLedger.price_fcfa) !== 0)) {
      throw new HttpError(503, 'Le journal post-production contient un coût inattendu; le traitement ne sera pas approuvé.');
    }
    if (!existingLedger) {
      const { error: ledgerError } = await admin.from('usage_ledger').insert({
        version_id: versionId, user_id: video.user_id, department: video.department ?? '', ai_model_id: null,
        kind: 'postprod', seconds: durationSeconds, cost_usd: 0, cost_eur: 0, cost_real_fcfa: 0,
        applied_fcfa_per_second: 0, price_fcfa: 0, status: 'charged',
      });
      if (ledgerError) {
        await admin.storage.from('videos').remove([finalPath]);
        throw new HttpError(503, 'Le fichier est prêt, mais son journal de coûts n’a pas pu être enregistré.');
      }
    }

    const { error: versionError } = await admin.from('video_versions').update({ status: 'ready', final_path: finalPath, overlay_variant: null, error_message: null, updated_at: new Date().toISOString() }).eq('id', versionId);
    if (versionError) throw new HttpError(503, 'Le MP4 final est enregistré; son état doit être réconcilié.');
    const { error: readyError } = await admin.from('videos').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', version.video_id);
    if (readyError) throw new HttpError(503, 'Le fichier final est prêt; son état doit être réconcilié.');
    return { id: versionId, status: 'ready' as const, finalPath };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function retryPostproduction(versionId: string, admin: AdminClient) {
  const { data: version, error } = await admin.from('video_versions').select('id,status,updated_at').eq('id', versionId).single();
  if (error || !version || version.status !== 'postprocessing') throw new HttpError(409, 'Cette version n’est pas en post-production.');
  if (Date.now() - new Date(version.updated_at).getTime() < 60_000) return { id: versionId, status: 'postprocessing' as const };
  const { data: claimed, error: claimError } = await admin.from('video_versions').update({ updated_at: new Date().toISOString() }).eq('id', versionId).eq('status', 'postprocessing').eq('updated_at', version.updated_at).select('id').maybeSingle();
  if (claimError) throw new HttpError(503, 'Impossible de réclamer la reprise de post-production.');
  if (!claimed) return { id: versionId, status: 'postprocessing' as const };
  return beginPostproduction(versionId);
}

function makeFfmpegArgs(input: { rawFile: string; audioFile: string | null; outputFile: string; durationSeconds: number }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input.rawFile];
  if (input.audioFile) args.push('-stream_loop', '-1', '-i', input.audioFile);
  args.push('-map', '0:v:0', '-c:v', 'copy');
  if (input.audioFile) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  args.push('-t', String(input.durationSeconds), '-movflags', '+faststart', input.outputFile);
  return args;
}

/** Join the two separately generated, stored clips into the user's final montage. */
export async function assembleShotMontage(versionId: string) {
  const admin = createStorageAdminClient();
  const { data: version, error: versionError } = await admin.from('video_versions')
    .select('id,video_id,final_path')
    .eq('id', versionId).single();
  if (versionError || !version) throw new HttpError(404, 'La version à assembler est introuvable.');
  if (version.final_path) return { finalPath: version.final_path as string };

  const { data: shots, error: shotsError } = await admin.from('video_shots')
    .select('shot_number,status,raw_path')
    .eq('version_id', versionId).order('shot_number');
  if (shotsError || !shots || shots.length !== 2 || shots.some((shot) => shot.status !== 'ready' || !shot.raw_path)) {
    throw new HttpError(409, 'Les deux plans doivent être prêts avant leur assemblage.');
  }
  try { await access(ffmpegPath, constants.X_OK); }
  catch { throw new HttpError(503, 'FFmpeg n’est pas disponible sur ce déploiement.'); }

  const clipBytes = await Promise.all(shots.map((shot, index) => downloadAsset(admin, 'videos', shot.raw_path, MAX_VIDEO_BYTES, `Le plan ${index + 1}`)));
  clipBytes.forEach(validateMp4);
  const directory = await mkdtemp(join(tmpdir(), 'rimco-montage-'));
  const clipFiles = [join(directory, 'shot-1.mp4'), join(directory, 'shot-2.mp4')];
  const outputFile = join(directory, 'montage.mp4');
  try {
    await Promise.all(clipFiles.map((path, index) => writeFile(path, clipBytes[index])));
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', clipFiles[0], '-i', clipFiles[1],
      '-filter_complex', '[0:v:0][1:v:0]concat=n=2:v=1:a=0[outv]',
      '-map', '[outv]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', '6', outputFile,
    ];
    await runFfmpeg(ffmpegPath, args);
    const outputStat = await stat(outputFile);
    if (outputStat.size > MAX_VIDEO_BYTES) throw new HttpError(502, 'Le montage dépasse la taille autorisée.');
    const output = await readFile(outputFile);
    validateMp4(output);
    const finalPath = `${version.video_id}/${versionId}/montage.mp4`;
    const { error: uploadError } = await admin.storage.from('videos').upload(finalPath, output, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new HttpError(502, 'Impossible d’enregistrer le montage dans le stockage sécurisé.');
    const { error: updateVersionError } = await admin.from('video_versions').update({ status: 'ready', final_path: finalPath, raw_path: null, error_message: null, updated_at: new Date().toISOString() }).eq('id', versionId);
    if (updateVersionError) throw new HttpError(503, 'Le montage est enregistré; son état doit être réconcilié.');
    const { error: updateVideoError } = await admin.from('videos').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', version.video_id);
    if (updateVideoError) throw new HttpError(503, 'Le montage est prêt; son état doit être réconcilié.');
    return { finalPath };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runFfmpeg(executable: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const process = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => process.kill('SIGKILL'), 45_000);
    process.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString('utf8').slice(0, 4_000 - stderr.length); });
    process.once('error', (error) => { clearTimeout(timeout); reject(new HttpError(503, `Impossible de démarrer FFmpeg : ${error.message}`)); });
    process.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new HttpError(502, signal === 'SIGKILL' ? 'La post-production dépasse le délai autorisé.' : `La post-production FFmpeg a échoué${stderr ? ` : ${stderr.trim().slice(-500)}` : '.'}`));
    });
  });
}

async function downloadAsset(admin: AdminClient, bucket: 'videos' | 'brand' | 'audio', path: string, maxBytes: number, label: string) {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) throw new HttpError(502, `${label} est introuvable dans le stockage sécurisé.`);
  if (data.size > maxBytes) throw new HttpError(413, `${label} dépasse la taille autorisée.`);
  return Buffer.from(await data.arrayBuffer());
}

function validateMp4(bytes: Buffer) {
  if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new HttpError(502, 'Le fichier vidéo reçu n’est pas un MP4 valide.');
}
