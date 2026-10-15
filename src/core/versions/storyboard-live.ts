import type { Actor } from '@/core/auth/guards';
import { HttpError } from '@/core/auth/guards';
import { buildBrief } from '@/core/brief';
import { getStoryboardModeRoute } from '@/core/providers/storyboard-routing';
import { wanReferenceVideoProvider, klingReferenceVideoProvider, seedanceReferenceVideoProvider, type ReferenceVideoProvider } from '@/core/providers/fal-reference-video';
import { klingVideoProvider } from '@/core/providers/fal-kling';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { env } from '@/env';
import { calculateClientPriceFcfa } from '@/core/pricing';
import { generatedVideoSeconds, shotToPrompt, type StoryboardShot, validateStoryboard } from '@/core/storyboard';
import { assembleShotMontage } from '@/core/postproduction/pipeline';
import type { CreateVersionInput } from './live';
import { reserveGenerationCost, settleUsageCost } from '@/core/billing/ledger';
import { findCuratedLocation, locationCatalog } from '@/core/assets/location-catalog';
import { createFalClient } from '@fal-ai/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const providers: Record<'wan' | 'kling' | 'seedance', ReferenceVideoProvider> = {
  wan: wanReferenceVideoProvider, kling: klingReferenceVideoProvider, seedance: seedanceReferenceVideoProvider,
};

export async function createLiveStoryboard(actor: Actor, input: CreateVersionInput & { storyboard: StoryboardShot[]; storyMode: 'standard' | 'pro' | 'premium'; finalDurationSeconds: 15 | 20; vehicleDossierId: string; placeIds: string[]; purpose: 'presentation' | 'advertising'; comparisonCampaignId?: string }) {
  if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');

  const authenticated = await createSupabaseServerClient();
  const admin = createStorageAdminClient();
  const route = getStoryboardModeRoute(input.storyMode);
  const provider = providers[route.adapterFamily];
  validateStoryboard(input.storyboard, input.finalDurationSeconds, route.adapterFamily);
  const [{ data: dossier, error: dossierError }, { data: model, error: modelError }] = await Promise.all([
    authenticated.from('vehicle_dossiers').select('id,make,model,color,variant,brand_id,assets(id,kind,path,title,angle,photo_role,status)').eq('id', input.vehicleDossierId).eq('brand_id', actor.brandId).single(),
    admin.from('ai_models').select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,pricing_verified_at,allowed_formats,is_active').eq('fal_endpoint_id', route.endpoint).eq('is_active', true).single(),
  ]);
  if (dossierError || !dossier) throw new HttpError(422, 'Choisissez un dossier véhicule de votre marque.');
  const vehiclePhotos = (dossier.assets ?? []).filter((asset) => asset.kind === 'vehicle' && asset.status === 'validée');
  const asset = vehiclePhotos.find((photo) => photo.id === input.assetId) ?? vehiclePhotos[0];
  if (!asset) throw new HttpError(422, 'Le dossier ne contient aucune photo validée.');
  if (modelError || !model || model.adapter_family !== route.adapterFamily) throw new HttpError(503, `Le modèle ${route.label} n’est pas activé dans la configuration fal.`);
  if (!model.pricing_verified_at || Date.now() - new Date(model.pricing_verified_at).getTime() > 7 * 24 * 60 * 60 * 1000) throw new HttpError(503, `Le tarif de ${route.label} doit être vérifié et daté avant tout lancement.`);
  if (!model.allowed_formats?.includes(input.format)) throw new HttpError(422, `${route.label} ne prend pas en charge le format ${input.format}.`);
  if (input.audioAssetId) throw new HttpError(422, 'Les vidéos multi-plans sont sans audio pour le moment.');

  const curatedPlaces = input.placeIds.map(findCuratedLocation).filter((place) => place !== undefined);
  const curatedIds = new Set<string>(curatedPlaces.map((place) => place.id));
  const uploadedPlaceIds = input.placeIds.filter((id) => !curatedIds.has(id));
  const locationsQuery = uploadedPlaceIds.length ? await authenticated.from('assets').select('id,path,title,kind,status,brand_id').in('id', uploadedPlaceIds).eq('kind', 'place').eq('status', 'validée').eq('brand_id', actor.brandId) : { data: [], error: null };
  if (locationsQuery.error || (locationsQuery.data ?? []).length !== uploadedPlaceIds.length) throw new HttpError(422, 'Un lieu sélectionné n’est plus disponible.');
  const placeAssets = [...curatedPlaces.map((place) => ({ id: place.id, path: place.path, title: place.title, kind: 'place' as const, status: 'validée' as const, brand_id: actor.brandId })), ...(locationsQuery.data ?? [])];
  const validVehiclePhotoIds = new Set(vehiclePhotos.map((photo) => photo.id));
  const validPlaceIds = new Set(placeAssets.map((photo) => photo.id));
  if (input.storyboard.some((shot) => !validVehiclePhotoIds.has(shot.vehiclePhotoId) || shot.locationPhotoId != null && !validPlaceIds.has(shot.locationPhotoId))) {
    throw new HttpError(422, 'Le storyboard référence une photo ou un lieu qui n’est pas validé dans votre sélection.');
  }

  const vehicleDescription = [dossier.make, dossier.model, dossier.variant, dossier.color].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
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
    duration_s: input.finalDurationSeconds,
    complexity: input.complexity,
  });
  const prompts = input.storyboard.map((shot, index) => shotToPrompt(brief, shot, index, input.storyboard.length, route.adapterFamily === 'seedance' ? '[' : '@'));
  const generatedSeconds = generatedVideoSeconds(input.finalDurationSeconds);
  const costUsd = generatedSeconds * Number(model.price_usd_per_second);
  const priceFcfa = calculateClientPriceFcfa(costUsd, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);

  const { data: video, error: videoError } = await admin.from('videos').insert({
    user_id: actor.id, brand_id: actor.brandId,
    title: input.title || `${dossier.make ?? ''} ${dossier.model ?? 'Véhicule'} · storyboard ${route.label}`.trim(),
    department: actor.department, status: 'generating',
  }).select('id').single();
  if (videoError || !video) throw new HttpError(500, 'Impossible de créer la vidéo. Réessayez.');
  const storedBrief = { ...brief, storyboard: input.storyboard, overlayLogo: true, multiClipMode: true, storyMode: input.storyMode, finalDurationSeconds: input.finalDurationSeconds, purpose: input.purpose, vehicleDossierId: input.vehicleDossierId, placeIds: input.placeIds, ...(input.comparisonCampaignId ? { comparisonCampaignId: input.comparisonCampaignId } : {}) };
  const { data: version, error: versionError } = await admin.from('video_versions').insert({
    video_id: video.id, number: 1, brief_json: storedBrief, generated_prompt: prompts.join('\n\n--- Plan suivant ---\n\n'),
    ai_model_id: model.id, status: 'queued', generation_seconds: input.finalDurationSeconds,
  }).select('id,number').single();
  if (versionError || !version) {
    await admin.from('videos').delete().eq('id', video.id);
    throw new HttpError(500, 'Impossible de créer la version de la vidéo. Réessayez.');
  }

  const { data: ledgerId, error: reserveError } = await reserveGenerationCost(admin, {
    userId: actor.id, versionId: version.id, modelId: model.id, seconds: generatedSeconds,
    priceUsdPerSecond: Number(model.price_usd_per_second), usdToEur: env.USD_TO_EUR_RATE,
    eurToFcfa: env.EUR_TO_FCFA, priceFcfa, department: actor.department,
  });
  if (reserveError || !ledgerId) {
    await Promise.all([admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
    throw new HttpError(503, 'Impossible d’enregistrer le suivi de coûts du montage.');
  }

  const shotRows = input.storyboard.map((shot, index) => ({
    version_id: version.id, shot_number: index + 1, duration_seconds: shot.durationSeconds,
    title: shot.title, generated_prompt: prompts[index], usage_ledger_id: ledgerId, status: 'queued',
    price_usd_per_second: Number(model.price_usd_per_second), estimated_cost_usd: shot.durationSeconds * Number(model.price_usd_per_second),
  }));
  const { error: shotsInsertError } = await admin.from('video_shots').insert(shotRows);
  if (shotsInsertError) {
    await Promise.all([
      settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Impossible d’enregistrer les plans.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Impossible d’enregistrer les plans du montage.');
  }

  const falStorage = env.FAL_KEY ? createFalClient({ credentials: env.FAL_KEY }).storage : null;
  const curatedUploads = new Map<string, Promise<string>>();
  const submissions = await Promise.allSettled(input.storyboard.map(async (shot, index) => {
    const vehiclePhoto = vehiclePhotos.find((photo) => photo.id === shot.vehiclePhotoId);
    const place = placeAssets.find((photo) => photo.id === shot.locationPhotoId);
    if (!vehiclePhoto) throw new HttpError(422, 'Le storyboard utilise une photo de véhicule non validée.');
    const refs = await Promise.all([vehiclePhoto.path, ...(place ? [place.path] : [])].map(async (path) => {
      if (path.startsWith('/places/')) {
        const curated = locationCatalog.find((entry) => entry.path === path);
        if (!curated || !falStorage) throw new HttpError(422, 'La photo du lieu n’est pas une référence de la médiathèque.');
        if (!curatedUploads.has(path)) {
          curatedUploads.set(path, readFile(join(process.cwd(), 'public', path.slice(1))).then((bytes) => {
            const mimeType = path.endsWith('.png') ? 'image/png' : 'image/jpeg';
            return falStorage.upload(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mimeType }), { lifecycle: { expiresIn: '1d' } });
          }));
        }
        return curatedUploads.get(path)!;
      }
      const { data: signed, error } = await admin.storage.from('assets').createSignedUrl(path, 3600);
      if (error || !signed?.signedUrl) throw new HttpError(422, 'Impossible de préparer une image de référence.');
      return signed.signedUrl;
    }));
    return provider.submit({ prompt: prompts[index], referenceImageUrls: refs, durationS: shot.durationSeconds, aspectRatio: '16:9', endUserId: actor.id });
  }));
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
      settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Aucun plan n’a pu démarrer.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Aucun plan n’a pu démarrer. La réservation a été libérée.');
  }
  await admin.from('video_versions').update({ status: 'generating', updated_at: new Date().toISOString() }).eq('id', version.id);
  return { id: version.id, status: 'generating' as const, prompt: prompts.join('\n\n--- Plan suivant ---\n\n'), estimatedPriceFcfa: priceFcfa, version: version.number, completedShots: 0, totalShots: input.storyboard.length };
}

export async function refreshLiveStoryboard(versionId: string, actor: Actor) {
  const admin = createStorageAdminClient();
  const { data: version, error } = await admin.from('video_versions')
    .select('id,video_id,status,final_path,ai_model_id,brief_json,model:ai_models!inner(adapter_family,price_usd_per_second),video:videos!inner(id,user_id,status)')
    .eq('id', versionId).single();
  if (error || !version) throw new HttpError(404, 'Cette version est introuvable.');
  const video = Array.isArray(version.video) ? version.video[0] : version.video;
  if (!video || video.user_id !== actor.id && actor.role !== 'admin') throw new HttpError(404, 'Cette version est introuvable.');
  if (version.status === 'ready' && version.final_path) return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, version.final_path) };
  if (version.status === 'failed') return { id: versionId, status: 'failed' as const, error: 'Un plan n’a pas pu être généré.' };

  const { data: shots, error: shotsError } = await admin.from('video_shots')
    .select('shot_number,duration_seconds,provider_request_id,status,raw_path,error_message')
    .eq('version_id', versionId).order('shot_number');
  if (shotsError || !shots || shots.length < 2 || shots.length > 6) throw new HttpError(503, 'Les plans de cette vidéo sont introuvables.');
  const model = Array.isArray(version.model) ? version.model[0] : version.model;
  const adapterFamily: 'wan' | 'kling' | 'seedance' = model?.adapter_family === 'wan' ? 'wan' : model?.adapter_family === 'seedance' ? 'seedance' : 'kling';
  const multiClip = version.brief_json && typeof version.brief_json === 'object' && (version.brief_json as { multiClipMode?: unknown }).multiClipMode === true;
  const statusProvider = multiClip ? providers[adapterFamily] : klingVideoProvider;

  await Promise.all(shots.filter((shot) => shot.status === 'generating' && shot.provider_request_id).map(async (shot) => {
    const state = await statusProvider.status(shot.provider_request_id);
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
    await admin.from('video_shots').update({ status: 'ready', raw_path: rawPath, actual_cost_usd: Number(shot.duration_seconds) * Number(model?.price_usd_per_second ?? 0), error_message: null, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shot.shot_number).eq('status', 'generating');
  }));

  const { data: latestShots, error: latestError } = await admin.from('video_shots').select('status,raw_path,duration_seconds').eq('version_id', versionId).order('shot_number');
  if (latestError || !latestShots) throw new HttpError(503, 'Impossible de relire l’état des plans.');
  const completedShots = latestShots.filter((shot) => shot.status === 'ready' && shot.raw_path).length;
  const pendingShots = latestShots.some((shot) => ['queued','generating','postprocessing'].includes(shot.status));
  if (pendingShots) return { id: versionId, status: 'generating' as const, completedShots, totalShots: latestShots.length };

  const { data: ledger, error: ledgerError } = await admin.from('usage_ledger').select('id,status').eq('version_id', versionId).eq('kind', 'generation').maybeSingle();
  if (ledgerError) throw new HttpError(503, 'Impossible de clôturer le budget des plans.');
  const priceUsdPerSecond = Number(model.price_usd_per_second);
  if (ledger?.status === 'reserved') {
    const outcome = completedShots > 0 ? 'charged' : 'released';
    const actualCostUsd = latestShots.filter((shot) => shot.status === 'ready').reduce((sum, shot) => sum + Number(shot.duration_seconds) * priceUsdPerSecond, 0);
    const { error: settleError } = await settleUsageCost(admin, {
      entryId: ledger.id, outcome, actualCostUsd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
    });
    if (settleError) throw new HttpError(503, 'La consommation fal doit être réconciliée avant de terminer le montage.');
  }
  if (completedShots !== latestShots.length) {
    const errorMessage = 'Un plan a échoué. Relancez la vidéo pour obtenir le montage complet.';
    await Promise.all([
      admin.from('video_versions').update({ status: 'failed', error_message: errorMessage, updated_at: new Date().toISOString() }).eq('id', versionId),
      admin.from('videos').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', version.video_id),
    ]);
    return { id: versionId, status: 'failed' as const, error: errorMessage, completedShots, totalShots: latestShots.length };
  }

  if (version.status !== 'postprocessing') {
    await admin.from('video_versions').update({ status: 'postprocessing', updated_at: new Date().toISOString() }).eq('id', versionId);
  }
  try {
    const { finalPath } = await assembleShotMontage(versionId);
    return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, finalPath), completedShots: latestShots.length, totalShots: latestShots.length };
  } catch (cause) {
    return { id: versionId, status: 'postprocessing' as const, error: cause instanceof Error ? cause.message : 'Le montage sera repris automatiquement.', completedShots: latestShots.length, totalShots: latestShots.length };
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
