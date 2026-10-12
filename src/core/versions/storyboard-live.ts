import type { Actor } from '@/core/auth/guards';
import { HttpError } from '@/core/auth/guards';
import { buildBrief } from '@/core/brief';
import { KLING_ENDPOINT, klingVideoProvider } from '@/core/providers/fal-kling';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { env } from '@/env';
import { calculateClientPriceFcfa } from '@/core/pricing';
import { shotToPrompt, type StoryboardShot } from '@/core/storyboard';
import { assembleShotMontage } from '@/core/postproduction/pipeline';
import type { CreateVersionInput } from './live';

const SHOT_DURATION_SECONDS = 3;
const SHOT_COUNT = 2;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export async function createLiveStoryboard(actor: Actor, input: CreateVersionInput & { storyboard: StoryboardShot[] }) {
  if (input.tier !== 'standard') throw new HttpError(422, 'Le montage multi-plans utilise le modèle Standard pendant la bêta.');
  if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');

  const authenticated = await createSupabaseServerClient();
  const admin = createStorageAdminClient();
  const [{ data: asset, error: assetError }, { data: model, error: modelError }] = await Promise.all([
    authenticated.from('assets').select('id,kind,path,make,model,color,status,brand_id').eq('id', input.assetId).single(),
    admin.from('ai_models').select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,allowed_formats,is_active').eq('fal_endpoint_id', KLING_ENDPOINT).eq('is_active', true).single(),
  ]);
  if (assetError || !asset || asset.kind !== 'vehicle' || asset.status !== 'validée' || asset.brand_id !== actor.brandId) throw new HttpError(422, 'Choisissez une photo de véhicule validée pour votre marque.');
  if (modelError || !model || model.adapter_family !== 'kling' || model.tier !== 'standard') throw new HttpError(503, 'Le modèle Kling O3 Pro n’est pas activé pour les tests multi-plans.');
  if (!model.allowed_formats?.includes(input.format)) throw new HttpError(422, `Kling O3 Pro ne prend pas en charge le format ${input.format}.`);
  if (input.audioAssetId) throw new HttpError(422, 'La piste audio sera ajoutée après le prototype multi-plans.');

  const { data: image, error: imageError } = await admin.storage.from('assets').createSignedUrl(asset.path, 3600);
  if (imageError || !image?.signedUrl) throw new HttpError(422, 'Impossible de préparer la photo sélectionnée.');
  const vehicleDescription = [asset.make, asset.model, asset.color].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
  const brief = buildBrief(input.description || 'Vidéo automobile élégante à Abidjan.', {
    vehicle_asset_id: asset.id,
    vehicle_description: vehicleDescription || 'Véhicule strictement identique à la photo de référence',
    vehicle_category: input.vehicleCategory,
    user_direction: input.description,
    location: input.location,
    setting: input.setting,
    character: input.character || 'Aucun personnage',
    lighting: input.lighting,
    camera_movement: input.cameraMovement,
    mood: input.mood,
    format: input.format,
    duration_s: 5,
    complexity: input.complexity,
  });
  const prompts = input.storyboard.map((shot, index) => shotToPrompt(brief, shot, index));
  const costUsd = SHOT_COUNT * SHOT_DURATION_SECONDS * Number(model.price_usd_per_second);
  const priceFcfa = calculateClientPriceFcfa(costUsd, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);

  const { data: video, error: videoError } = await admin.from('videos').insert({
    user_id: actor.id, brand_id: actor.brandId,
    title: input.title || `${asset.make ?? ''} ${asset.model ?? 'Véhicule'} · montage test`.trim(),
    department: actor.department, status: 'generating',
  }).select('id').single();
  if (videoError || !video) throw new HttpError(500, 'Impossible de créer la vidéo. Réessayez.');
  const storedBrief = { ...brief, storyboard: input.storyboard };
  const { data: version, error: versionError } = await admin.from('video_versions').insert({
    video_id: video.id, number: 1, brief_json: storedBrief, generated_prompt: prompts.join('\n\n--- Plan suivant ---\n\n'),
    ai_model_id: model.id, status: 'queued', generation_seconds: 6,
  }).select('id,number').single();
  if (versionError || !version) {
    await admin.from('videos').delete().eq('id', video.id);
    throw new HttpError(500, 'Impossible de créer la version de la vidéo. Réessayez.');
  }

  const { data: ledgerId, error: reserveError } = await admin.rpc('reserve_budget', {
    p_user_id: actor.id, p_version_id: version.id, p_model_id: model.id, p_seconds: SHOT_COUNT * SHOT_DURATION_SECONDS,
    p_price_usd_second: Number(model.price_usd_per_second), p_usd_to_eur: env.USD_TO_EUR_RATE,
    p_eur_to_fcfa: env.EUR_TO_FCFA, p_price_fcfa: priceFcfa,
    p_department: actor.department, p_applied_fcfa_second: priceFcfa / (SHOT_COUNT * SHOT_DURATION_SECONDS),
  });
  if (reserveError || !ledgerId) {
    await Promise.all([admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
    throw new HttpError(503, 'Impossible d’enregistrer le suivi de coûts du montage.');
  }

  const shotRows = input.storyboard.map((shot, index) => ({
    version_id: version.id, shot_number: index + 1, duration_seconds: SHOT_DURATION_SECONDS,
    title: shot.title, generated_prompt: prompts[index], usage_ledger_id: ledgerId, status: 'queued',
  }));
  const { error: shotsInsertError } = await admin.from('video_shots').insert(shotRows);
  if (shotsInsertError) {
    await Promise.all([
      admin.rpc('settle_budget', { p_entry_id: ledgerId, p_outcome: 'released', p_actual_cost_usd: 0, p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Impossible d’enregistrer les plans.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Impossible d’enregistrer les plans du montage.');
  }

  const submissions = await Promise.allSettled(input.storyboard.map((_, index) =>
    klingVideoProvider.submit({ prompt: prompts[index], imageUrl: image.signedUrl, durationS: SHOT_DURATION_SECONDS, format: input.format, endUserId: actor.id }),
  ));
  let submitted = 0;
  for (let index = 0; index < submissions.length; index += 1) {
    const submission = submissions[index];
    if (submission.status === 'fulfilled') {
      submitted += 1;
      await admin.from('video_shots').update({ provider_request_id: submission.value.requestId, status: 'generating', updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
    } else {
      await admin.from('video_shots').update({ status: 'failed', error_message: 'Impossible de démarrer ce plan auprès du fournisseur.', updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
    }
  }
  if (!submitted) {
    await Promise.all([
      admin.rpc('settle_budget', { p_entry_id: ledgerId, p_outcome: 'released', p_actual_cost_usd: 0, p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Aucun plan n’a pu démarrer.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Aucun plan n’a pu démarrer. La réservation a été libérée.');
  }
  await admin.from('video_versions').update({ status: 'generating', updated_at: new Date().toISOString() }).eq('id', version.id);
  return { id: version.id, status: 'generating' as const, prompt: prompts.join('\n\n--- Plan suivant ---\n\n'), estimatedPriceFcfa: priceFcfa, version: version.number, completedShots: 0, totalShots: SHOT_COUNT };
}

export async function refreshLiveStoryboard(versionId: string, actor: Actor) {
  const admin = createStorageAdminClient();
  const { data: version, error } = await admin.from('video_versions')
    .select('id,video_id,status,final_path,ai_model_id,model:ai_models!inner(adapter_family,price_usd_per_second),video:videos!inner(id,user_id,status)')
    .eq('id', versionId).single();
  if (error || !version) throw new HttpError(404, 'Cette version est introuvable.');
  const video = Array.isArray(version.video) ? version.video[0] : version.video;
  if (!video || video.user_id !== actor.id && actor.role !== 'admin') throw new HttpError(404, 'Cette version est introuvable.');
  if (version.status === 'ready' && version.final_path) return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, version.final_path) };
  if (version.status === 'failed') return { id: versionId, status: 'failed' as const, error: 'Un plan n’a pas pu être généré.' };

  const { data: shots, error: shotsError } = await admin.from('video_shots')
    .select('shot_number,duration_seconds,provider_request_id,status,raw_path,error_message')
    .eq('version_id', versionId).order('shot_number');
  if (shotsError || !shots || shots.length !== SHOT_COUNT) throw new HttpError(503, 'Les plans de cette vidéo sont introuvables.');
  const model = Array.isArray(version.model) ? version.model[0] : version.model;

  await Promise.all(shots.filter((shot) => shot.status === 'generating' && shot.provider_request_id).map(async (shot) => {
    const state = await klingVideoProvider.status(shot.provider_request_id);
    if (state.status === 'failed') {
      await admin.from('video_shots').update({ status: 'failed', error_message: state.error ?? 'La génération fal a échoué.', updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shot.shot_number).eq('status', 'generating');
      return;
    }
    if (state.status !== 'ready' || !state.videoUrl) return;
    const parsed = acceptedFalUrl(state.videoUrl);
    if (!parsed) throw new HttpError(502, 'Le fournisseur a retourné une URL vidéo non autorisée.');
    const response = await fetch(parsed, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new HttpError(502, `Impossible de récupérer le plan ${shot.shot_number}.`);
    const bytes = await readBoundedVideo(response, MAX_VIDEO_BYTES);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new HttpError(502, `Le plan ${shot.shot_number} n’est pas un MP4 valide.`);
    const rawPath = `${version.video_id}/${versionId}/shot-${shot.shot_number}.mp4`;
    const { error: uploadError } = await admin.storage.from('videos').upload(rawPath, bytes, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new HttpError(502, `Impossible d’enregistrer le plan ${shot.shot_number}.`);
    await admin.from('video_shots').update({ status: 'ready', raw_path: rawPath, error_message: null, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shot.shot_number).eq('status', 'generating');
  }));

  const { data: latestShots, error: latestError } = await admin.from('video_shots').select('status,raw_path').eq('version_id', versionId).order('shot_number');
  if (latestError || !latestShots) throw new HttpError(503, 'Impossible de relire l’état des plans.');
  const completedShots = latestShots.filter((shot) => shot.status === 'ready' && shot.raw_path).length;
  const pendingShots = latestShots.some((shot) => ['queued','generating','postprocessing'].includes(shot.status));
  if (pendingShots) return { id: versionId, status: 'generating' as const, completedShots, totalShots: SHOT_COUNT };

  const { data: ledger, error: ledgerError } = await admin.from('usage_ledger').select('id,status').eq('version_id', versionId).eq('kind', 'generation').maybeSingle();
  if (ledgerError) throw new HttpError(503, 'Impossible de clôturer le budget des plans.');
  const priceUsdPerSecond = Number(model.price_usd_per_second);
  if (ledger?.status === 'reserved') {
    const outcome = completedShots > 0 ? 'charged' : 'released';
    const actualCostUsd = completedShots * SHOT_DURATION_SECONDS * priceUsdPerSecond;
    const { error: settleError } = await admin.rpc('settle_budget', {
      p_entry_id: ledger.id, p_outcome: outcome, p_actual_cost_usd: actualCostUsd,
      p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA,
    });
    if (settleError) throw new HttpError(503, 'La consommation fal doit être réconciliée avant de terminer le montage.');
  }
  if (completedShots !== SHOT_COUNT) {
    const errorMessage = 'Un plan a échoué. Relancez la vidéo pour obtenir le montage complet.';
    await Promise.all([
      admin.from('video_versions').update({ status: 'failed', error_message: errorMessage, updated_at: new Date().toISOString() }).eq('id', versionId),
      admin.from('videos').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', version.video_id),
    ]);
    return { id: versionId, status: 'failed' as const, error: errorMessage, completedShots, totalShots: SHOT_COUNT };
  }

  if (version.status !== 'postprocessing') {
    await admin.from('video_versions').update({ status: 'postprocessing', updated_at: new Date().toISOString() }).eq('id', versionId);
  }
  try {
    const { finalPath } = await assembleShotMontage(versionId);
    return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, finalPath), completedShots: SHOT_COUNT, totalShots: SHOT_COUNT };
  } catch (cause) {
    return { id: versionId, status: 'postprocessing' as const, error: cause instanceof Error ? cause.message : 'Le montage sera repris automatiquement.', completedShots: SHOT_COUNT, totalShots: SHOT_COUNT };
  }
}

async function signedUrl(admin: ReturnType<typeof createStorageAdminClient>, path: string) {
  const { data, error } = await admin.storage.from('videos').createSignedUrl(path, 3600);
  if (error || !data) throw new HttpError(503, 'Impossible de créer le lien temporaire du montage.');
  return data.signedUrl;
}

function acceptedFalUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'fal.media' || host.endsWith('.fal.media') || host === 'storage.googleapis.com') ? url : null;
  } catch { return null; }
}

async function readBoundedVideo(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new HttpError(502, 'Le fournisseur n’a retourné aucun fichier vidéo.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new HttpError(502, 'La vidéo générée dépasse la taille autorisée.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
