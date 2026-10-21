import type { Actor } from '@/core/auth/guards';
import { HttpError } from '@/core/auth/guards';
import { buildBrief } from '@/core/brief';
import { getStoryboardModeRoute } from '@/core/providers/storyboard-routing';
import { wanReferenceVideoProvider, klingReferenceVideoProvider, seedanceReferenceVideoProvider, safeProviderError, type ReferenceVideoProvider } from '@/core/providers/fal-reference-video';
import { buildKeyframeAnimationPrompt, buildKeyframePrompt, buildKeyframeQualityPrompt, buildVideoQualityPrompt, canAnimateKeyframes, keyframeQualityAction, shouldExcludePeople, videoQualityAction, KEYFRAME_IMAGE_COST_USD, KEYFRAME_QUALITY_RESERVE_USD, KEYFRAME_VIDEO_ENDPOINTS, KEYFRAME_IMAGE_ENDPOINT, KEYFRAME_VISION_ENDPOINT, keyframeVideoProviders, readKeyframe, readKeyframeQuality, selectKeyframeReferenceIds, shouldGenerateKeyframes, submitKeyframe, submitKeyframeQuality } from '@/core/providers/fal-keyframes';
import { logFalStatusFailure } from '@/core/providers/fal-observability';
import { klingVideoProvider, KLING_ENDPOINT } from '@/core/providers/fal-kling';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { serverVideoObjects } from '@/core/storage/server-video-objects';
import { keyframeImageUploadTarget } from '@/core/storage/keyframe-image';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { env } from '@/env';
import { estimateGridPriceFcfa } from '@/core/pricing';
import { firstObservedAt, type ProcessingMetrics } from './processing-metrics';
import { expandSingleShotStoryboard, finalVideoSeconds, isPremiumTenSecondAd, premiumTenSecondAdDurations, shotToPrompt, type ClipDurationSeconds, type StoryboardShot, validatePremiumTenSecondAdStoryboard, validatePremiumTwentySecondStoryboard, validateSingleShotStoryboard, validateStoryboard, validateTierDuration } from '@/core/storyboard';
import { assembleShotMontage, extractRepresentativeVideoFrames } from '@/core/postproduction/pipeline';
import type { CreateVersionInput } from './live';
import { animationSubmitStateAfterFailure, canSubmitAnimation } from './animation-submit-state';
import { reserveGenerationCost, reserveKeyframeCost, settleUsageCost } from '@/core/billing/ledger';
import { findCuratedLocation, locationCatalog } from '@/core/assets/location-catalog';
import { createFalClient } from '@fal-ai/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getActiveFalCredential, getFalCredentialById, pruneRetiredFalCredentials } from '@/core/providers/fal-credential-vault';
import { falErrorStatusCode, isFalPollDue, planFalPollFailure } from '@/core/providers/fal-polling';

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

async function recordPollFailure(input: {
  admin: ReturnType<typeof createStorageAdminClient>;
  versionId: string;
  shotNumber: number;
  shot: Record<string, unknown>;
  stage: 'keyframe' | 'quality' | 'video' | 'video_quality';
  cause: unknown;
  apiKey: string;
  now: string;
}) {
  const plan = planFalPollFailure(input.cause, Number(input.shot.provider_poll_failure_count ?? 0), new Date(input.now));
  const detail = safeProviderError(input.cause, input.apiKey);
  const terminal = plan.action === 'fail';
  const statusField = input.stage === 'video' ? 'status' : input.stage === 'video_quality' ? 'video_quality_status' : 'keyframe_status';
  const update: Record<string, unknown> = {
    provider_poll_failure_count: plan.failureCount,
    provider_next_poll_at: plan.nextPollAt,
    provider_last_poll_error: detail,
    provider_reconciliation_required: terminal,
    updated_at: input.now,
    error_message: terminal ? `Le suivi fal a échoué (${falErrorStatusCode(input.cause) ?? 'réseau'}) : ${detail}` : null,
  };
  if (terminal) update[statusField] = 'failed';
  const { error } = await input.admin.from('video_shots').update(update).eq('version_id', input.versionId).eq('shot_number', input.shotNumber);
  if (error) throw new HttpError(503, 'Impossible d’enregistrer l’état du suivi fal.');
  console.error('fal_poll_recovery', JSON.stringify({ versionId: input.versionId, shotNumber: input.shotNumber, stage: input.stage, action: plan.action, failureCount: plan.failureCount, statusCode: falErrorStatusCode(input.cause), detail }));
  return plan;
}

async function settleQualityLedger(admin: ReturnType<typeof createStorageAdminClient>, entryId: string, costUsd: number) {
  const settlement = await settleUsageCost(admin, { entryId, outcome: 'charged', actualCostUsd: costUsd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
  if (!settlement.error) return;
  const { data, error } = await admin.from('usage_ledger').select('status').eq('id', entryId).maybeSingle();
  if (error || data?.status !== 'charged') throw new HttpError(503, 'Le coût du contrôle qualité doit être réconcilié avant la suite du traitement.');
}

const providers: Record<'wan' | 'kling' | 'seedance', ReferenceVideoProvider> = {
  wan: wanReferenceVideoProvider, kling: klingReferenceVideoProvider, seedance: seedanceReferenceVideoProvider,
};

async function resolveFalAssetUrl(path: string, admin: ReturnType<typeof createStorageAdminClient>, falStorage: ReturnType<typeof createFalClient>['storage'], uploads: Map<string, Promise<string>>) {
  if (path.startsWith('/places/')) {
    const curated = locationCatalog.find((entry) => entry.path === path);
    if (!curated || !falStorage) throw new HttpError(422, 'La photo du lieu n’est pas une référence de la médiathèque.');
    if (!uploads.has(path)) {
      uploads.set(path, readFile(join(process.cwd(), 'public', path.slice(1))).then((bytes) => {
        const extension = path.split('.').at(-1)?.toLowerCase();
        const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
        return falStorage.upload(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mimeType }), { lifecycle: { expiresIn: '1d' } });
      }));
    }
    return uploads.get(path)!;
  }
  const { data: signed, error } = await admin.storage.from('assets').createSignedUrl(path, 3600);
  if (error || !signed?.signedUrl) throw new HttpError(422, 'Impossible de préparer une image de référence.');
  return signed.signedUrl;
}

export async function createLiveStoryboard(actor: Actor, input: CreateVersionInput & { storyboard: StoryboardShot[]; workflow?: 'single' | 'multi_clip'; storyMode: 'standard' | 'pro' | 'premium'; clipDurationSeconds: ClipDurationSeconds; vehicleDossierId: string; vehicleDossierIds: string[]; placeIds: string[]; purpose: 'presentation' | 'advertising'; storyboardLedgerIds?: string[]; comparisonCampaignId?: string }) {
  if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');

  const authenticated = await createSupabaseServerClient();
  const admin = createStorageAdminClient();
  const route = getStoryboardModeRoute(input.storyMode);
  const provider = providers[route.adapterFamily];
  const keyframeMode = shouldGenerateKeyframes(input.storyMode);
  const animationEndpoint = KEYFRAME_VIDEO_ENDPOINTS[route.adapterFamily];
  const isSingleShot = input.workflow === 'single';
  const premiumTenSecondAd = input.workflow === 'multi_clip' && isPremiumTenSecondAd(input.storyMode, input.purpose, input.clipDurationSeconds);
  const premiumTwentySecond = input.workflow === 'multi_clip' && input.storyMode === 'premium' && input.clipDurationSeconds === 20;
  const premiumQualityMode = input.storyMode === 'premium' && input.workflow !== 'single';
  validateTierDuration(input.storyMode, input.clipDurationSeconds);
  if (isSingleShot) validateSingleShotStoryboard(input.storyboard, input.clipDurationSeconds, route.adapterFamily);
  else if (premiumTenSecondAd) validatePremiumTenSecondAdStoryboard(input.storyboard);
  else if (premiumTwentySecond) validatePremiumTwentySecondStoryboard(input.storyboard);
  else {
    validateStoryboard(input.storyboard, input.clipDurationSeconds, route.adapterFamily);
  }
  const generationShots = isSingleShot
    ? expandSingleShotStoryboard(input.storyboard[0], input.clipDurationSeconds, route.adapterFamily)
    : premiumTenSecondAd
      ? input.storyboard.map((shot) => ({ ...shot, durationSeconds: 4 }))
      : input.storyboard;
  const premiumDurations = premiumTenSecondAd ? premiumTenSecondAdDurations() : null;
  const dossierIds = [...new Set([input.vehicleDossierId, ...input.vehicleDossierIds])];
  const [{ data: dossiers, error: dossierError }, { data: model, error: modelError }, { data: animationModel, error: animationModelError }] = await Promise.all([
    authenticated.from('vehicle_dossiers').select('id,make,model,color,variant,brand_id,assets(id,kind,path,title,angle,photo_role,status)').in('id', dossierIds).eq('brand_id', actor.brandId),
    admin.from('ai_models').select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,pricing_verified_at,allowed_formats,allowed_durations,is_active').eq('fal_endpoint_id', route.endpoint).eq('is_active', true).single(),
    keyframeMode ? admin.from('ai_models').select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,pricing_verified_at,allowed_formats,allowed_durations,is_active').eq('fal_endpoint_id', animationEndpoint).eq('is_active', true).single() : Promise.resolve({ data: null, error: null }),
  ]);
  const dossier = dossiers?.find((entry) => entry.id === input.vehicleDossierId);
  if (dossierError || !dossiers || !dossier || dossiers.length !== dossierIds.length) throw new HttpError(422, 'Choisissez des dossiers véhicule de votre marque.');
  const normalize = (value: string | null) => (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('fr');
  const identity = (entry: typeof dossier) => [entry.make, entry.model, entry.color, entry.variant].map(normalize).join('|');
  if (new Set(dossiers.map(identity)).size !== 1) throw new HttpError(422, 'Les dossiers regroupés doivent décrire exactement le même véhicule.');
  const vehiclePhotos = dossiers.flatMap((entry) => entry.assets ?? []).filter((asset) => asset.kind === 'vehicle' && asset.status === 'validée');
  const asset = vehiclePhotos.find((photo) => photo.id === input.assetId) ?? vehiclePhotos[0];
  if (!asset) throw new HttpError(422, 'Le dossier ne contient aucune photo validée.');
  if (modelError || !model || model.adapter_family !== route.adapterFamily) throw new HttpError(503, `Le modèle ${route.label} n’est pas activé dans la configuration fal.`);
  if (!model.pricing_verified_at || Date.now() - new Date(model.pricing_verified_at).getTime() > 7 * 24 * 60 * 60 * 1000) throw new HttpError(503, `Le tarif de ${route.label} doit être vérifié et daté avant tout lancement.`);
  if (keyframeMode && (animationModelError || !animationModel || animationModel.adapter_family !== route.adapterFamily || animationModel.tier !== input.storyMode)) throw new HttpError(503, `Le modèle image-clé ${route.label} n’est pas activé dans la configuration fal.`);
  const videoModel = keyframeMode ? animationModel : model;
  if (!videoModel) throw new HttpError(503, `Le modèle vidéo ${route.label} n’est pas configuré.`);
  if (keyframeMode && (!videoModel.pricing_verified_at || Date.now() - new Date(videoModel.pricing_verified_at).getTime() > 7 * 24 * 60 * 60 * 1000)) throw new HttpError(503, `Le tarif du modèle vidéo ${route.label} doit être vérifié et daté avant tout lancement.`);
  if (!videoModel.allowed_formats?.includes(input.format)) throw new HttpError(422, `${route.label} ne prend pas en charge le format ${input.format}.`);
  if (generationShots.some((shot) => !videoModel.allowed_durations?.includes(shot.durationSeconds))) throw new HttpError(422, `La durée d’un clip n’est pas prise en charge par ${route.label}. Réduisez le nombre de plans ou choisissez une autre durée totale.`);
  if (input.audioAssetId) throw new HttpError(422, 'Les vidéos multi-plans sont sans audio pour le moment.');

  const curatedPlaces = input.placeIds.map(findCuratedLocation).filter((place) => place !== undefined);
  const curatedIds = new Set<string>(curatedPlaces.map((place) => place.id));
  const uploadedPlaceIds = input.placeIds.filter((id) => !curatedIds.has(id));
  const locationsQuery = uploadedPlaceIds.length ? await authenticated.from('assets').select('id,path,title,kind,status,brand_id').in('id', uploadedPlaceIds).eq('kind', 'place').eq('status', 'validée').eq('brand_id', actor.brandId) : { data: [], error: null };
  if (locationsQuery.error || (locationsQuery.data ?? []).length !== uploadedPlaceIds.length) throw new HttpError(422, 'Un lieu sélectionné n’est plus disponible.');
  const placeAssets = [...curatedPlaces.map((place) => ({ id: place.id, path: place.path, title: place.title, kind: 'place' as const, status: 'validée' as const, brand_id: actor.brandId })), ...(locationsQuery.data ?? [])];
  const requestedVehicleIds = new Set(input.vehiclePhotoIds);
  const selectedVehiclePhotos = input.vehiclePhotoIds.length
    ? vehiclePhotos.filter((photo) => requestedVehicleIds.has(photo.id))
    : vehiclePhotos;
  if (input.vehiclePhotoIds.length && selectedVehiclePhotos.length !== requestedVehicleIds.size) throw new HttpError(422, 'Une ou plusieurs vues sélectionnées du véhicule ne sont plus disponibles.');
  const validVehiclePhotoIds = new Set(vehiclePhotos.map((photo) => photo.id));
  const validPlaceIds = new Set(placeAssets.map((photo) => photo.id));
  if (generationShots.some((shot) => !validVehiclePhotoIds.has(shot.vehiclePhotoId) || shot.locationPhotoId != null && !validPlaceIds.has(shot.locationPhotoId))) {
    throw new HttpError(422, 'Le storyboard référence une photo ou un lieu qui n’est pas validé dans votre sélection.');
  }

  const vehicleDescription = [dossier.make, dossier.model, dossier.variant, dossier.color].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
  const keyframeReferencesByShot = keyframeMode ? generationShots.map((shot, index) => {
    const referencePool = [
      ...selectedVehiclePhotos,
      ...vehiclePhotos.filter((photo) => !requestedVehicleIds.has(photo.id)),
    ];
    return {
      shotNumber: index + 1,
      assetIds: selectKeyframeReferenceIds({
        primaryVehiclePhotoId: shot.vehiclePhotoId,
        vehiclePhotos: referencePool.map((photo) => ({ id: photo.id, angle: photo.angle, photo_role: photo.photo_role })),
        locationPhotoId: shot.locationPhotoId,
      }),
    };
  }) : [];
  const brief = buildBrief(input.description || 'Vidéo automobile élégante à Abidjan.', {
    vehicle_asset_id: asset.id,
    vehicle_description: vehicleDescription || 'Véhicule strictement identique à la photo de référence',
    vehicle_category: input.vehicleCategory,
    user_direction: input.description,
    location: input.location,
    setting: input.setting,
    character: premiumTenSecondAd ? 'none; absolutely no visible driver, passenger, person, face, or human silhouette, including inside the vehicle' : input.character || 'as explicitly requested in the user direction; otherwise none',
    lighting: input.lighting,
    camera_movement: input.cameraMovement,
    mood: input.mood,
    format: input.format,
    duration_s: input.clipDurationSeconds,
    complexity: input.complexity,
  });
  const prompts = generationShots.map((shot, index) => {
    const reference = vehiclePhotos.find((photo) => photo.id === shot.vehiclePhotoId);
    return shotToPrompt(brief, shot, index, generationShots.length, '@', {
      role: reference?.photo_role,
      angle: reference?.angle,
    });
  });
  const generatedSeconds = generationShots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const maximumGeneratedSeconds = generatedSeconds * (premiumQualityMode ? 2 : 1);
  const { data: pricingSettings, error: pricingError } = await admin.from('pricing_settings')
    .select('grid_fcfa_per_second_standard,grid_fcfa_per_second_premium').eq('brand_id', actor.brandId).maybeSingle();
  if (pricingError || !pricingSettings) throw new HttpError(503, 'La grille tarifaire de votre marque n’est pas configurée.');
  const priceFcfa = estimateGridPriceFcfa(input.clipDurationSeconds, input.storyMode, {
    standard: Number(pricingSettings.grid_fcfa_per_second_standard), premium: Number(pricingSettings.grid_fcfa_per_second_premium),
  });

  const falCredential = await getActiveFalCredential(admin);
  const { data: video, error: videoError } = await admin.from('videos').insert({
    user_id: actor.id, brand_id: actor.brandId,
    title: input.title || `${dossier.make ?? ''} ${dossier.model ?? 'Véhicule'} · storyboard ${route.label}`.trim(),
    department: actor.department, status: 'generating',
  }).select('id').single();
  if (videoError || !video) throw new HttpError(500, 'Impossible de créer la vidéo. Réessayez.');
  const storedBrief = { ...brief, storyboard: generationShots, approvedStoryboard: input.storyboard, generationTier: input.storyMode, overlayLogo: input.overlayLogo, multiClipMode: !isSingleShot, singleStoryboardMode: isSingleShot, storyMode: input.storyMode, clipDurationSeconds: input.clipDurationSeconds, finalDurationSeconds: finalVideoSeconds(input.clipDurationSeconds), purpose: input.purpose, vehicleDossierId: input.vehicleDossierId, vehiclePhotoIds: selectedVehiclePhotos.map((photo) => photo.id), keyframeReferencesByShot, placeIds: input.placeIds, ...(premiumTenSecondAd ? { premiumAdCutMode: true, shotOutputDurations: premiumDurations!.editorial, videoRetryReserveSeconds: generatedSeconds } : {}), ...(premiumQualityMode ? { videoQualityMode: true } : {}), processingMetrics: { requestedAt: new Date().toISOString() }, shotProcessingMetrics: {}, ...(input.comparisonCampaignId ? { comparisonCampaignId: input.comparisonCampaignId } : {}) };
  const { data: version, error: versionError } = await admin.from('video_versions').insert({
    video_id: video.id, number: 1, brief_json: storedBrief, generated_prompt: prompts.join('\n\n--- Plan suivant ---\n\n'),
    ai_model_id: videoModel.id, fal_credential_id: falCredential.id, status: 'queued', generation_seconds: finalVideoSeconds(input.clipDurationSeconds),
  }).select('id,number').single();
  if (versionError || !version) {
    await admin.from('videos').delete().eq('id', video.id);
    throw new HttpError(500, 'Impossible de créer la version de la vidéo. Réessayez.');
  }

  let storyboardCostUsd = 0;
  const storyboardLedgerIds = input.storyboardLedgerIds ?? [];
  if (storyboardLedgerIds.length) {
    const { data: storyboardLedgers, error: storyboardLedgerError } = await admin.from('usage_ledger')
      .select('id,cost_usd,status,version_id,user_id,ai_model_id')
      .in('id', storyboardLedgerIds).eq('user_id', actor.id).eq('status', 'charged')
      .is('version_id', null).is('ai_model_id', null);
    if (storyboardLedgerError || !storyboardLedgers || storyboardLedgers.length !== storyboardLedgerIds.length) {
      await Promise.all([admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
      throw new HttpError(422, 'Le coût du storyboard ne peut pas être associé à cette vidéo. Régénérez le storyboard.');
    }
    const { data: linkedLedger, error: linkError } = await admin.from('usage_ledger')
      .update({ version_id: version.id }).in('id', storyboardLedgerIds).is('version_id', null).select('id');
    if (linkError || !linkedLedger || linkedLedger.length !== storyboardLedgerIds.length) {
      await Promise.all([admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
      throw new HttpError(409, 'Ce coût de storyboard est déjà associé à une autre vidéo. Régénérez le storyboard.');
    }
    storyboardCostUsd = storyboardLedgers.reduce((sum, row) => sum + Number(row.cost_usd), 0);
  }

  const { data: ledgerId, error: reserveError } = await reserveGenerationCost(admin, {
    userId: actor.id, versionId: version.id, modelId: videoModel.id, seconds: maximumGeneratedSeconds, billableSeconds: input.clipDurationSeconds,
    priceUsdPerSecond: Number(videoModel.price_usd_per_second), usdToEur: env.USD_TO_EUR_RATE,
    eurToFcfa: env.EUR_TO_FCFA, priceFcfa, department: actor.department,
  });
  if (reserveError || !ledgerId) {
    await Promise.all([admin.from('usage_ledger').update({ version_id: null }).eq('version_id', version.id).eq('status', 'charged'), admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
    throw new HttpError(503, 'Impossible d’enregistrer le suivi de coûts du montage.');
  }

  const shotRows = generationShots.map((shot, index) => ({
    version_id: version.id, shot_number: index + 1, duration_seconds: shot.durationSeconds,
    title: shot.title, generated_prompt: prompts[index], usage_ledger_id: ledgerId, status: 'queued', keyframe_status: keyframeMode ? 'queued' : 'skipped',
    provider_endpoint: keyframeMode ? animationEndpoint : route.endpoint,
    price_usd_per_second: Number(videoModel.price_usd_per_second), estimated_cost_usd: shot.durationSeconds * Number(videoModel.price_usd_per_second) * (premiumQualityMode ? 2 : 1),
    video_quality_status: premiumQualityMode ? 'queued' : 'skipped', animation_submit_state: 'queued',
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

  if (keyframeMode) {
    const keyframeLedgers = new Map<number, { imageIds: string[]; qualityIds: string[]; videoQualityIds: string[] }>();
    const reservations: string[] = [];
    try {
      for (let index = 0; index < generationShots.length; index += 1) {
        const imageIds: string[] = [];
        const qualityIds: string[] = [];
        const videoQualityIds: string[] = [];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const imageReservation = await reserveKeyframeCost(admin, {
            userId: actor.id, versionId: version.id, department: actor.department,
            estimatedCostUsd: KEYFRAME_IMAGE_COST_USD, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
          });
          if (imageReservation.error || !imageReservation.data) throw new HttpError(503, 'Impossible de réserver le coût de création des images-clés.');
          reservations.push(imageReservation.data); imageIds.push(imageReservation.data);
          const qualityReservation = await reserveKeyframeCost(admin, {
            userId: actor.id, versionId: version.id, department: actor.department,
            estimatedCostUsd: KEYFRAME_QUALITY_RESERVE_USD, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
          });
          if (qualityReservation.error || !qualityReservation.data) throw new HttpError(503, 'Impossible de réserver le coût de contrôle des images-clés.');
          reservations.push(qualityReservation.data); qualityIds.push(qualityReservation.data);
        }
        if (premiumQualityMode) {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const videoQualityReservation = await reserveKeyframeCost(admin, {
              userId: actor.id, versionId: version.id, department: actor.department,
              estimatedCostUsd: KEYFRAME_QUALITY_RESERVE_USD, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
            });
            if (videoQualityReservation.error || !videoQualityReservation.data) throw new HttpError(503, 'Impossible de réserver le coût de contrôle des clips vidéo.');
            reservations.push(videoQualityReservation.data); videoQualityIds.push(videoQualityReservation.data);
          }
        }
        keyframeLedgers.set(index + 1, { imageIds, qualityIds, videoQualityIds });
      }
    } catch (cause) {
      await Promise.all(reservations.map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false })));
      await Promise.all([
        settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
        admin.from('video_versions').update({ status: 'failed', error_message: cause instanceof Error ? cause.message : 'Impossible de réserver les images-clés.' }).eq('id', version.id),
        admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
      ]);
      throw cause;
    }
    for (const [shotNumber, ledgers] of keyframeLedgers) {
      const { error } = await admin.from('video_shots').update({ keyframe_image_ledger_ids: ledgers.imageIds, keyframe_quality_ledger_ids: ledgers.qualityIds, video_quality_ledger_ids: ledgers.videoQualityIds }).eq('version_id', version.id).eq('shot_number', shotNumber);
      if (error) {
        await Promise.all([
          ...reservations.map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false })),
          settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
          admin.from('video_versions').update({ status: 'failed', error_message: 'Impossible d’enregistrer les réservations des images-clés.' }).eq('id', version.id),
          admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
        ]);
        throw new HttpError(503, 'Impossible d’enregistrer les réservations des images-clés. Aucun fournisseur n’a été appelé.');
      }
    }

    const falStorage = createFalClient({ credentials: falCredential.apiKey }).storage;
    const uploads = new Map<string, Promise<string>>();
    const keyframeSubmissions = await Promise.allSettled(generationShots.map(async (shot, index) => {
      const vehiclePhoto = vehiclePhotos.find((photo) => photo.id === shot.vehiclePhotoId);
      const place = placeAssets.find((photo) => photo.id === shot.locationPhotoId);
      if (!vehiclePhoto) throw new HttpError(422, 'Le storyboard utilise une photo de véhicule non validée.');
      const referenceIds = keyframeReferencesByShot[index]?.assetIds ?? [vehiclePhoto.id, ...(place ? [place.id] : [])];
      const references = referenceIds.map((id) => id === place?.id ? place : vehiclePhotos.find((photo) => photo.id === id)).filter((reference): reference is NonNullable<typeof reference> => Boolean(reference));
      if (references.length !== referenceIds.length || references[0]?.id !== vehiclePhoto.id || place && references.at(-1)?.id !== place.id) throw new HttpError(422, 'L’ordre des références image-clé est invalide.');
      const imageUrls = await Promise.all(references.map((reference) => resolveFalAssetUrl(reference.path, admin, falStorage, uploads)));
      const vehicleReferenceCount = references.filter((reference) => reference.id !== place?.id).length;
      const prompt = buildKeyframePrompt({ shot, vehicle: vehicleDescription, lighting: brief.lighting, format: input.format, retryReason: null, vehicleReferenceCount, hasLocationReference: Boolean(place), excludePeople: shouldExcludePeople(String(brief.character ?? ''), String(brief.user_direction ?? '')) });
      return submitKeyframe({ prompt, imageUrls, aspectRatio: input.format }, falCredential.apiKey);
    }));
    let submittedKeyframes = 0;
    for (let index = 0; index < keyframeSubmissions.length; index += 1) {
      const result = keyframeSubmissions[index];
      if (result.status === 'fulfilled') {
        submittedKeyframes += 1;
        const { error: updateError } = await admin.from('video_shots').update({ keyframe_request_id: result.value.requestId, keyframe_endpoint: KEYFRAME_IMAGE_ENDPOINT, keyframe_status: 'generating', provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
        if (updateError) {
          const retryWrite = await admin.from('video_shots').update({ keyframe_request_id: result.value.requestId, keyframe_endpoint: KEYFRAME_IMAGE_ENDPOINT, keyframe_status: 'generating', provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
          if (!retryWrite.error) continue;
          await Promise.all([
            ...((keyframeLedgers.get(index + 1)?.qualityIds ?? []).map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }))),
            ...((keyframeLedgers.get(index + 1)?.imageIds.slice(1) ?? []).map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }))),
            ...((keyframeLedgers.get(index + 1)?.videoQualityIds ?? []).map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }))),
          ]);
          await admin.from('video_shots').update({ keyframe_status: 'failed', provider_reconciliation_required: true, provider_last_poll_error: `request_id=${result.value.requestId}`, error_message: 'fal a accepté l’image-clé, mais son identifiant n’a pas pu être enregistré. Vérification manuelle nécessaire; aucun clip vidéo ne sera lancé.', updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
        }
      } else {
        const ids = keyframeLedgers.get(index + 1);
        const statusCode = falErrorStatusCode(result.reason);
        const uncertain = statusCode === null || statusCode >= 500;
        const releaseIds = ids ? [...(uncertain ? [...ids.qualityIds, ...ids.imageIds.slice(1), ...ids.qualityIds.slice(1)] : [...ids.imageIds, ...ids.qualityIds]), ...ids.videoQualityIds] : [];
        await Promise.all(releaseIds.map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false })));
        await admin.from('video_shots').update({ keyframe_status: 'failed', provider_reconciliation_required: uncertain, provider_last_poll_error: safeProviderError(result.reason, falCredential.apiKey), error_message: uncertain ? 'fal n’a pas confirmé si la création de cette image-clé a été acceptée. La réservation reste à réconcilier.' : `fal a refusé la création de cette image-clé (${statusCode}) : ${safeProviderError(result.reason, falCredential.apiKey)}`, updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
      }
    }
    if (!submittedKeyframes) {
      const { data: uncertainShots } = await admin.from('video_shots').select('shot_number').eq('version_id', version.id).eq('provider_reconciliation_required', true);
      await Promise.all([
        ...(uncertainShots?.length ? [] : [settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA })]),
        admin.from('video_versions').update({ status: 'failed', error_message: uncertainShots?.length ? 'Le lancement fal reste à réconcilier. Aucun plan vidéo ne sera envoyé avant vérification.' : 'Aucune image-clé n’a pu démarrer. Aucun plan vidéo n’a été envoyé.' }).eq('id', version.id),
        admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
      ]);
      throw new HttpError(503, 'Aucune image-clé n’a pu démarrer. Réessayez plus tard.');
    }
    const keyframingStartedAt = new Date().toISOString();
    await admin.from('video_versions').update({ status: 'generating', brief_json: { ...storedBrief, keyframeMode: true, processingMetrics: { ...storedBrief.processingMetrics, keyframingStartedAt } }, updated_at: keyframingStartedAt }).eq('id', version.id);
    return { id: version.id, status: 'generating' as const, prompt: prompts.join('\n\n--- Plan suivant ---\n\n'), estimatedPriceFcfa: priceFcfa, storyboardCostUsd, version: version.number, completedShots: 0, totalShots: generationShots.length, completedKeyframes: 0, totalKeyframes: generationShots.length, ...(premiumQualityMode ? { checkedQualityShots: 0, totalQualityShots: generationShots.length, shotProgress: generationShots.map((shot, index) => ({ number: index + 1, title: shot.title, status: 'queued', qualityStatus: 'queued' })) } : {}), processingStage: 'keyframing' as const };
  }

  const falStorage = createFalClient({ credentials: falCredential.apiKey }).storage;
  const curatedUploads = new Map<string, Promise<string>>();
  const submissions = await Promise.allSettled(generationShots.map(async (shot, index) => {
    const vehiclePhoto = vehiclePhotos.find((photo) => photo.id === shot.vehiclePhotoId);
    const place = placeAssets.find((photo) => photo.id === shot.locationPhotoId);
    if (!vehiclePhoto) throw new HttpError(422, 'Le storyboard utilise une photo de véhicule non validée.');
    const refs = await Promise.all([vehiclePhoto.path, ...(place ? [place.path] : [])].map(async (path) => {
      if (path.startsWith('/places/')) {
        const curated = locationCatalog.find((entry) => entry.path === path);
        if (!curated || !falStorage) throw new HttpError(422, 'La photo du lieu n’est pas une référence de la médiathèque.');
        if (!curatedUploads.has(path)) {
          curatedUploads.set(path, readFile(join(process.cwd(), 'public', path.slice(1))).then((bytes) => {
            const extension = path.split('.').at(-1)?.toLowerCase();
            const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
            return falStorage.upload(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mimeType }), { lifecycle: { expiresIn: '1d' } });
          }));
        }
        return curatedUploads.get(path)!;
      }
      const { data: signed, error } = await admin.storage.from('assets').createSignedUrl(path, 3600);
      if (error || !signed?.signedUrl) throw new HttpError(422, 'Impossible de préparer une image de référence.');
      return signed.signedUrl;
    }));
    return provider.submit({ prompt: prompts[index], referenceImageUrls: refs, durationS: shot.durationSeconds, aspectRatio: input.format, endUserId: actor.id }, falCredential.apiKey);
  }));
  let submitted = 0;
  for (let index = 0; index < submissions.length; index += 1) {
    const submission = submissions[index];
    if (submission.status === 'fulfilled') {
      submitted += 1;
      const submissionPatch = { provider_request_id: submission.value.requestId, provider_endpoint: provider.endpoint, status: 'generating', provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, updated_at: new Date().toISOString() };
      const firstWrite = await admin.from('video_shots').update(submissionPatch).eq('version_id', version.id).eq('shot_number', index + 1);
      if (firstWrite.error) {
        const recoveredWrite = await admin.from('video_shots').update(submissionPatch).eq('version_id', version.id).eq('shot_number', index + 1);
        if (recoveredWrite.error) await admin.from('video_shots').update({ status: 'failed', provider_reconciliation_required: true, provider_last_poll_error: `request_id=${submission.value.requestId}`, error_message: 'fal a accepté la séquence, mais son identifiant n’a pas pu être enregistré. Vérification manuelle nécessaire.', updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
      }
    } else {
      const providerError = safeProviderError(submission.reason, falCredential.apiKey);
      const statusCode = falErrorStatusCode(submission.reason);
      const uncertain = statusCode === null || statusCode >= 500;
      console.error('[video-generation] Séquence non démarrée.', { versionId: version.id, shotNumber: index + 1, statusCode, detail: providerError });
      await admin.from('video_shots').update({ status: 'failed', provider_reconciliation_required: uncertain, provider_last_poll_error: providerError, error_message: uncertain ? 'fal n’a pas confirmé si la séquence a été acceptée. La réservation reste à réconcilier.' : `fal a refusé la séquence (${statusCode}) : ${providerError}`, updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
    }
  }
  if (!submitted) {
    const { data: uncertainShots } = await admin.from('video_shots').select('shot_number').eq('version_id', version.id).eq('provider_reconciliation_required', true);
    await Promise.all([
      ...(uncertainShots?.length ? [] : [settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA })]),
      admin.from('video_versions').update({ status: 'failed', error_message: uncertainShots?.length ? 'Le lancement fal reste à réconcilier. La réservation n’a pas été libérée.' : 'Aucun plan n’a pu démarrer. La réservation a été libérée.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Aucun plan n’a pu démarrer. La réservation a été libérée. Réessayez plus tard.');
  }
  const providerSubmittedAt = new Date().toISOString();
  const submittedBrief = { ...storedBrief, processingMetrics: { ...storedBrief.processingMetrics, providerSubmittedAt } };
  await admin.from('video_versions').update({ status: 'generating', brief_json: submittedBrief, updated_at: providerSubmittedAt }).eq('id', version.id);
  const totalEstimatedPriceFcfa = priceFcfa;
  return { id: version.id, status: 'generating' as const, prompt: prompts.join('\n\n--- Plan suivant ---\n\n'), estimatedPriceFcfa: totalEstimatedPriceFcfa, storyboardCostUsd, version: version.number, completedShots: 0, totalShots: generationShots.length };
}

async function refreshKeyframes(input: {
  admin: ReturnType<typeof createStorageAdminClient>;
  version: { id: string; video_id: string; ai_model_id: string | null };
  video: { id: string; user_id: string; brand_id: string | null };
  shots: Array<Record<string, unknown>>;
  actor: Actor;
  brief: Record<string, unknown>;
  apiKey: string;
  adapterFamily: 'wan' | 'kling' | 'seedance';
}) {
  const { admin, version, video, shots, brief, apiKey, adapterFamily } = input;
  const shotDrafts = Array.isArray(brief.storyboard) ? brief.storyboard as StoryboardShot[] : [];
  const draftsByNumber = new Map(shotDrafts.map((shot, index) => [index + 1, shot]));
  const anyKeyframes = shots.some((shot) => shot.keyframe_status !== 'skipped');
  if (!anyKeyframes) return null;
  if (canAnimateKeyframes(shots.map((shot) => String(shot.keyframe_status))) && shots.some((shot) => typeof shot.provider_request_id === 'string')) return null;

  const persistedReferences = Array.isArray(brief.keyframeReferencesByShot)
    ? brief.keyframeReferencesByShot as Array<{ shotNumber: number; assetIds: string[] }>
    : [];
  const referenceByShot = new Map(persistedReferences.map((entry) => [entry.shotNumber, entry.assetIds]));
  const selectedPlaceIds = shotDrafts.map((shot) => shot.locationPhotoId).filter((id): id is string => Boolean(id));
  const legacyVehicleIds = shotDrafts.map((shot) => shot.vehiclePhotoId);
  const vehicleIds = [...new Set([
    ...legacyVehicleIds,
    ...persistedReferences.flatMap((entry) => entry.assetIds).filter((id) => !selectedPlaceIds.includes(id)),
  ])];
  const curatedLocations = selectedPlaceIds.map(findCuratedLocation).filter((place) => place !== undefined);
  const curatedIds = new Set<string>(curatedLocations.map((place) => place.id));
  const uploadedPlaceIds = [...new Set(selectedPlaceIds.filter((id) => !curatedIds.has(id)))];
  const { data: vehicleAssets, error: vehicleError } = await admin.from('assets').select('id,path,kind,status,brand_id').in('id', vehicleIds).eq('kind', 'vehicle').eq('status', 'validée').eq('brand_id', video.brand_id);
  const { data: placeAssets, error: placeError } = uploadedPlaceIds.length
    ? await admin.from('assets').select('id,path,kind,status,brand_id').in('id', uploadedPlaceIds).eq('kind', 'place').eq('status', 'validée').eq('brand_id', video.brand_id)
    : { data: [], error: null };
  if (vehicleError || placeError || (vehicleAssets ?? []).length !== vehicleIds.length || (placeAssets ?? []).length !== uploadedPlaceIds.length) throw new HttpError(422, 'Une référence validée n’est plus accessible pour contrôler les images-clés.');
  const assetsById = new Map([...(vehicleAssets ?? []), ...(placeAssets ?? [])].map((asset) => [asset.id, asset]));
  const locationPaths = new Map<string, string>(curatedLocations.map((place) => [place.id, place.path]));
  const falStorage = createFalClient({ credentials: apiKey }).storage;
  const uploads = new Map<string, Promise<string>>();
  const now = new Date().toISOString();
  const outcomes = await Promise.allSettled(shots.map(async (shot) => {
    const shotNumber = Number(shot.shot_number);
    const draft = draftsByNumber.get(shotNumber);
    const imageLedgerIds = Array.isArray(shot.keyframe_image_ledger_ids) ? shot.keyframe_image_ledger_ids as string[] : [];
    const qualityLedgerIds = Array.isArray(shot.keyframe_quality_ledger_ids) ? shot.keyframe_quality_ledger_ids as string[] : [];
    const attempt = Number(shot.keyframe_retry_count ?? 0);
    const activeKeyframePoll = ['generating', 'checking'].includes(String(shot.keyframe_status));
    if (activeKeyframePoll && (!isFalPollDue(shot.provider_next_poll_at) || Number(shot.provider_poll_failure_count ?? 0) >= 4)) return;
    if (!draft || imageLedgerIds.length !== 2 || qualityLedgerIds.length !== 2) throw new HttpError(503, `Le suivi de l’image-clé ${shotNumber} est incomplet.`);
    const vehicle = assetsById.get(draft.vehiclePhotoId);
    const persistedAssetIds = referenceByShot.get(shotNumber);
    const referenceIds = persistedAssetIds?.length ? persistedAssetIds : [draft.vehiclePhotoId, ...(draft.locationPhotoId ? [draft.locationPhotoId] : [])];
    const vehicleReferenceIds = referenceIds.filter((id) => id !== draft.locationPhotoId);
    const placePath = draft.locationPhotoId ? locationPaths.get(draft.locationPhotoId) ?? assetsById.get(draft.locationPhotoId)?.path : undefined;
    if (!vehicle || !placePath && draft.locationPhotoId) throw new HttpError(422, `Une référence du plan ${shotNumber} n’est plus disponible.`);
    if (vehicleReferenceIds[0] !== draft.vehiclePhotoId || draft.locationPhotoId && referenceIds.at(-1) !== draft.locationPhotoId) throw new HttpError(422, `L’ordre des références mémorisées du plan ${shotNumber} est invalide.`);
    const referencePaths = referenceIds.map((id) => id === draft.locationPhotoId
      ? placePath
      : assetsById.get(id)?.path);
    if (referencePaths.some((path) => !path)) throw new HttpError(422, `Une vue validée du véhicule du plan ${shotNumber} n’est plus accessible.`);
    const referenceUrls = await Promise.all(referencePaths.map((path) => resolveFalAssetUrl(path!, admin, falStorage, uploads)));
    const vehicleReferenceCount = vehicleReferenceIds.length;
    const imageLedgerId = imageLedgerIds[attempt];
    const qualityLedgerId = qualityLedgerIds[attempt];
    if (shot.keyframe_status === 'generating' && typeof shot.keyframe_request_id === 'string') {
      let state;
      try {
        state = await readKeyframe(shot.keyframe_request_id, apiKey, String(shot.keyframe_endpoint || KEYFRAME_IMAGE_ENDPOINT));
      } catch (cause) {
        await recordPollFailure({ admin, versionId: version.id, shotNumber, shot, stage: 'keyframe', cause, apiKey, now });
        return;
      }
      if (Number(shot.provider_poll_failure_count ?? 0) > 0) {
        await admin.from('video_shots').update({ provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null }).eq('version_id', version.id).eq('shot_number', shotNumber);
      }
      if (state.status === 'failed') {
        await admin.from('video_shots').update({ keyframe_status: 'failed', provider_reconciliation_required: true, provider_next_poll_at: null, provider_last_poll_error: 'fal a déclaré la tâche image en échec', error_message: 'fal a déclaré la création de cette image-clé en échec. Son coût reste à réconcilier.', updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
        return;
      }
      if (state.status === 'generating') return;
      const parsed = acceptedFalUrl(state.imageUrl);
      if (!parsed) throw new HttpError(502, `L’URL de l’image-clé ${shotNumber} n’est pas autorisée.`);
      await settleUsageCost(admin, { entryId: imageLedgerId, outcome: 'charged', actualCostUsd: KEYFRAME_IMAGE_COST_USD, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
      const response = await fetch(parsed, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new HttpError(502, `Impossible de récupérer l’image-clé ${shotNumber}.`);
      const bytes = await readBoundedImage(response, MAX_IMAGE_BYTES);
      const contentType = state.contentType;
      const target = keyframeImageUploadTarget({ videoId: version.video_id, versionId: version.id, shotNumber, contentType });
      const { error: uploadError } = await admin.storage.from(target.bucket).upload(target.path, bytes, target.options);
      if (uploadError) {
        console.error('keyframe_storage_upload_failed', JSON.stringify({
          versionId: version.id,
          shotNumber,
          code: uploadError.name,
          message: uploadError.message,
        }));
        await Promise.all([
          settleUsageCost(admin, { entryId: qualityLedgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
          admin.from('video_shots').update({ keyframe_status: 'failed', error_message: `Impossible d’enregistrer l’image-clé ${shotNumber}.`, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber),
        ]);
        return;
      }
      const { data: signed, error: signedError } = await admin.storage.from(target.bucket).createSignedUrl(target.path, 3600);
      if (signedError || !signed?.signedUrl) throw new HttpError(503, 'Impossible de créer le lien de contrôle temporaire.');
      const excludePeople = shouldExcludePeople(String(brief.character ?? ''), String(brief.user_direction ?? ''));
      const visionPrompt = `${buildKeyframeQualityPrompt({ vehicleReferenceCount, hasLocationReference: Boolean(draft.locationPhotoId), excludePeople })} Plan: ${draft.title}; scène: ${draft.scene}; cadrage: ${draft.framing}; lieu: ${draft.location}.`;
      let qualityJob: { requestId: string };
      try {
        qualityJob = await submitKeyframeQuality({ prompt: visionPrompt, imageUrls: [signed.signedUrl, ...referenceUrls] }, apiKey);
      } catch (cause) {
        const statusCode = falErrorStatusCode(cause);
        const uncertain = statusCode === null || statusCode >= 500;
        if (!uncertain) await settleUsageCost(admin, { entryId: qualityLedgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        await admin.from('video_shots').update({
          keyframe_status: 'failed',
          provider_reconciliation_required: uncertain,
          provider_next_poll_at: null,
          provider_last_poll_error: safeProviderError(cause, apiKey),
          error_message: uncertain
            ? 'Le contrôle fal n’a pas confirmé si la demande a été acceptée. La réservation est conservée pour réconciliation avant toute relance.'
            : `fal a refusé le contrôle visuel (${statusCode}) : ${safeProviderError(cause, apiKey)}`,
          updated_at: now,
        }).eq('version_id', version.id).eq('shot_number', shotNumber);
        return;
      }
      const qualityJobPatch = { keyframe_status: 'checking', keyframe_path: target.path, keyframe_quality_request_id: qualityJob.requestId, keyframe_quality_endpoint: KEYFRAME_VISION_ENDPOINT, provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, provider_reconciliation_required: false, updated_at: now };
      const { error: updateError } = await admin.from('video_shots').update(qualityJobPatch).eq('version_id', version.id).eq('shot_number', shotNumber);
      if (updateError) {
        const recoveredWrite = await admin.from('video_shots').update(qualityJobPatch).eq('version_id', version.id).eq('shot_number', shotNumber);
        if (recoveredWrite.error) {
          await admin.from('video_shots').update({ keyframe_status: 'failed', provider_reconciliation_required: true, provider_last_poll_error: `request_id=${qualityJob.requestId}`, error_message: 'fal a accepté le contrôle de l’image-clé, mais son identifiant n’a pas pu être enregistré. Vérification manuelle nécessaire.', updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
        }
      }
      return;
    }
    if (shot.keyframe_status !== 'checking' || typeof shot.keyframe_quality_request_id !== 'string') return;
    let state;
    try {
      state = await readKeyframeQuality(shot.keyframe_quality_request_id, apiKey, String(shot.keyframe_quality_endpoint || KEYFRAME_VISION_ENDPOINT));
    } catch (cause) {
      await recordPollFailure({ admin, versionId: version.id, shotNumber, shot, stage: 'quality', cause, apiKey, now });
      return;
    }
    if (Number(shot.provider_poll_failure_count ?? 0) > 0) {
      await admin.from('video_shots').update({ provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null }).eq('version_id', version.id).eq('shot_number', shotNumber);
    }
    if (state.status === 'checking') return;
    if (state.status === 'failed' || !state.quality) {
      if (state.error) console.error('keyframe_quality_failed', JSON.stringify({
        versionId: version.id,
        shotNumber,
        requestId: shot.keyframe_quality_request_id,
        reason: state.error,
      }));
      if (state.costUsd !== null) await settleUsageCost(admin, { entryId: qualityLedgerId, outcome: 'charged', actualCostUsd: state.costUsd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
      await admin.from('video_shots').update({ keyframe_status: 'failed', provider_reconciliation_required: true, provider_next_poll_at: null, provider_last_poll_error: state.error ?? 'réponse de contrôle invalide', error_message: `Le contrôle automatique a échoué. La réservation reste à réconcilier.${state.error ? ` Détail : ${safeProviderError(state.error, apiKey)}` : ''}`, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
      return;
    }
    const quality = state.quality;
    const qualityCostUsd = state.costUsd ?? KEYFRAME_QUALITY_RESERVE_USD;
    await settleUsageCost(admin, { entryId: qualityLedgerId, outcome: 'charged', actualCostUsd: qualityCostUsd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
    const qualityAction = keyframeQualityAction(quality.approved, attempt);
    if (qualityAction === 'accept') {
      if (attempt === 0) {
        await Promise.all([
          settleUsageCost(admin, { entryId: imageLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
          settleUsageCost(admin, { entryId: qualityLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
        ]);
      }
      await admin.from('video_shots').update({ keyframe_status: 'ready', keyframe_quality: quality, provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, error_message: null, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
      return;
    }
    if (qualityAction === 'retry') {
      const vehicleDescription = String(brief.vehicle_description ?? 'Véhicule fidèle à la photo validée');
      const prompt = buildKeyframePrompt({ shot: draft, vehicle: vehicleDescription, lighting: String(brief.lighting ?? ''), format: String(brief.format ?? '16:9'), retryReason: quality.issues.join('; ') || quality.reason, vehicleReferenceCount, hasLocationReference: Boolean(draft.locationPhotoId) });
      let retryRequestId: string | null = null;
      try {
        const retryJob = await submitKeyframe({ prompt, imageUrls: referenceUrls, aspectRatio: String(brief.format ?? '16:9') }, apiKey);
        retryRequestId = retryJob.requestId;
        const { error: updateError } = await admin.from('video_shots').update({ keyframe_status: 'generating', keyframe_request_id: retryJob.requestId, keyframe_endpoint: KEYFRAME_IMAGE_ENDPOINT, keyframe_quality_request_id: null, keyframe_quality_endpoint: null, keyframe_path: null, keyframe_quality: quality, keyframe_retry_count: 1, provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
        if (updateError) throw new HttpError(503, 'Impossible d’enregistrer la reprise de l’image-clé.');
      } catch (cause) {
        if (retryRequestId) {
          const recoveredWrite = await admin.from('video_shots').update({ keyframe_status: 'generating', keyframe_request_id: retryRequestId, keyframe_endpoint: KEYFRAME_IMAGE_ENDPOINT, keyframe_quality_request_id: null, keyframe_quality_endpoint: null, keyframe_path: null, keyframe_quality: quality, keyframe_retry_count: 1, provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
          if (!recoveredWrite.error) return;
          await Promise.all([
            settleUsageCost(admin, { entryId: qualityLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
            admin.from('video_shots').update({ keyframe_status: 'failed', provider_reconciliation_required: true, provider_last_poll_error: `request_id=${retryRequestId}`, error_message: 'fal a accepté la reprise de l’image-clé, mais son identifiant n’a pas pu être enregistré. Vérification manuelle nécessaire.', updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber),
          ]);
          return;
        }
        const statusCode = falErrorStatusCode(cause);
        const uncertain = statusCode === null || statusCode >= 500;
        await Promise.all([
          ...(uncertain ? [] : [settleUsageCost(admin, { entryId: imageLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false })]),
          settleUsageCost(admin, { entryId: qualityLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
          admin.from('video_shots').update({ keyframe_status: 'failed', provider_reconciliation_required: uncertain, provider_last_poll_error: safeProviderError(cause, apiKey), keyframe_quality: quality, error_message: uncertain ? 'fal n’a pas confirmé si la reprise de l’image-clé a été acceptée. La réservation est conservée pour réconciliation.' : `fal a refusé la reprise de l’image-clé (${statusCode}) : ${safeProviderError(cause, apiKey)}`, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber),
        ]);
      }
      return;
    }
    await admin.from('video_shots').update({ keyframe_status: 'failed', keyframe_quality: quality, error_message: `Image-clé refusée après une reprise : ${quality.issues.join('; ') || quality.reason}`, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
  }));
  const failure = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;

  const { data: refreshedShots, error: refreshedError } = await admin.from('video_shots')
    .select('shot_number,duration_seconds,title,generated_prompt,provider_request_id,status,raw_path,error_message,keyframe_status,keyframe_request_id,keyframe_quality_request_id,keyframe_path,keyframe_retry_count,keyframe_quality,keyframe_image_ledger_ids,keyframe_quality_ledger_ids,video_quality_ledger_ids,provider_poll_failure_count,provider_next_poll_at,provider_reconciliation_required,animation_submit_state,animation_submit_started_at')
    .eq('version_id', version.id).order('shot_number');
  if (refreshedError || !refreshedShots) throw new HttpError(503, 'Impossible de relire la progression des images-clés.');
  const completedKeyframes = refreshedShots.filter((shot) => shot.keyframe_status === 'ready').length;
  const keyframes = await Promise.all(refreshedShots.filter((shot) => typeof shot.keyframe_path === 'string').map(async (shot) => {
    const { data, error } = await admin.storage.from('videos').createSignedUrl(shot.keyframe_path!, 3600);
    return error || !data?.signedUrl ? null : { number: shot.shot_number, title: shot.title, url: data.signedUrl, quality: shot.keyframe_quality };
  }));
  const keyframePreviews = keyframes.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const pendingKeyframes = refreshedShots.some((shot) => ['queued','generating','checking'].includes(shot.keyframe_status));
  if (pendingKeyframes) return { id: version.id, status: 'generating' as const, processingStage: 'keyframing' as const, completedKeyframes, totalKeyframes: refreshedShots.length, keyframes: keyframePreviews, completedShots: 0, totalShots: refreshedShots.length };
  if (completedKeyframes !== refreshedShots.length) {
    const { data: generationLedger } = await admin.from('usage_ledger').select('id').eq('version_id', version.id).eq('kind', 'generation').eq('ai_model_id', version.ai_model_id).eq('status', 'reserved').maybeSingle();
    if (generationLedger?.id) await settleUsageCost(admin, { entryId: generationLedger.id, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA });
    const error = refreshedShots.find((shot) => shot.keyframe_status === 'failed')?.error_message ?? 'Une image-clé n’a pas passé le contrôle. Aucun plan vidéo n’a été envoyé.';
    const unusedRetryReservations = refreshedShots.flatMap((shot) => [
      ...(Number(shot.keyframe_retry_count ?? 0) === 0 ? [...(Array.isArray(shot.keyframe_image_ledger_ids) ? shot.keyframe_image_ledger_ids.slice(1) : []), ...(Array.isArray(shot.keyframe_quality_ledger_ids) ? shot.keyframe_quality_ledger_ids.slice(1) : [])] : []),
      ...(Array.isArray(shot.video_quality_ledger_ids) ? shot.video_quality_ledger_ids : []),
    ]);
    await Promise.all([
      ...unusedRetryReservations.map((entryId) => settleUsageCost(admin, { entryId: String(entryId), outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false })),
      admin.from('video_versions').update({ status: 'failed', error_message: error, updated_at: now }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed', updated_at: now }).eq('id', version.video_id),
    ]);
    return { id: version.id, status: 'failed' as const, error, completedKeyframes, totalKeyframes: refreshedShots.length, keyframes: keyframePreviews };
  }
  if (canAnimateKeyframes(refreshedShots.map((shot) => shot.keyframe_status)) && refreshedShots.some((shot) => typeof shot.provider_request_id === 'string')) return null;
  const animationTargets = refreshedShots.filter((shot) => canSubmitAnimation(shot.animation_submit_state, shot.provider_request_id));
  if (!animationTargets.length) return null;

  const provider = keyframeVideoProviders[adapterFamily];
  const animationJobs = await Promise.allSettled(animationTargets.map(async (shot) => {
    const claimTime = new Date().toISOString();
    const { data: claim, error: claimError } = await admin.from('video_shots').update({ animation_submit_state: 'submitting', animation_submit_started_at: claimTime }).eq('version_id', version.id).eq('shot_number', shot.shot_number).eq('animation_submit_state', 'queued').is('provider_request_id', null).select('shot_number').maybeSingle();
    if (claimError) throw new HttpError(503, 'Impossible de verrouiller la soumission du plan. Réessayez le suivi.');
    if (!claim) return;
    const draft = draftsByNumber.get(Number(shot.shot_number));
    if (!draft || !shot.keyframe_path) throw new HttpError(422, 'Une image-clé validée est introuvable.');
    const { data: signed, error } = await admin.storage.from('videos').createSignedUrl(shot.keyframe_path, 3600);
    if (error || !signed?.signedUrl) throw new HttpError(503, 'Impossible de préparer une image-clé pour son animation.');
    const prompt = buildKeyframeAnimationPrompt({
      shot: draft, vehicle: String(brief.vehicle_description ?? 'Véhicule de référence'),
      durationS: Number(shot.duration_seconds), mood: String(brief.mood ?? ''), lighting: String(brief.lighting ?? ''),
      excludePeople: shouldExcludePeople(String(brief.character ?? ''), String(brief.user_direction ?? '')),
    });
    const job = await provider.submit({ prompt, referenceImageUrls: [signed.signedUrl], durationS: Number(shot.duration_seconds), aspectRatio: String(brief.format ?? '16:9'), endUserId: String(video.user_id) }, apiKey);
    const animationPatch = { provider_request_id: job.requestId, provider_endpoint: provider.endpoint, animation_submit_state: 'submitted', status: 'generating', generated_prompt: prompt, provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, provider_reconciliation_required: false, updated_at: now };
    const firstWrite = await admin.from('video_shots').update(animationPatch).eq('version_id', version.id).eq('shot_number', shot.shot_number);
    if (firstWrite.error) {
      const recoveredWrite = await admin.from('video_shots').update(animationPatch).eq('version_id', version.id).eq('shot_number', shot.shot_number);
      if (recoveredWrite.error) await admin.from('video_shots').update({ status: 'failed', animation_submit_state: 'reconciliation', provider_reconciliation_required: true, provider_last_poll_error: `request_id=${job.requestId}`, error_message: 'fal a accepté l’animation, mais son identifiant n’a pas pu être enregistré. Vérification manuelle nécessaire.', updated_at: now }).eq('version_id', version.id).eq('shot_number', shot.shot_number);
    }
  }));
  for (let index = 0; index < animationJobs.length; index += 1) {
    const result = animationJobs[index];
    if (result.status === 'rejected') {
      const statusCode = falErrorStatusCode(result.reason);
      const uncertain = statusCode === null || statusCode >= 500;
      await admin.from('video_shots').update({
        status: 'failed', animation_submit_state: animationSubmitStateAfterFailure(statusCode), video_quality_status: brief.videoQualityMode === true ? 'failed' : 'skipped', provider_reconciliation_required: uncertain,
        provider_last_poll_error: safeProviderError(result.reason, apiKey), provider_next_poll_at: null,
        error_message: uncertain ? 'fal n’a pas confirmé si l’animation a été acceptée. Le coût reste réservé pour réconciliation.' : `fal a refusé l’animation (${statusCode}) : ${safeProviderError(result.reason, apiKey)}`,
        updated_at: now,
      }).eq('version_id', version.id).eq('shot_number', Number(animationTargets[index].shot_number));
    }
  }
  const metrics = brief.processingMetrics && typeof brief.processingMetrics === 'object' ? brief.processingMetrics as ProcessingMetrics : {};
  const keyframeCompletedAt = new Date().toISOString();
  const updatedBrief = { ...brief, processingMetrics: { ...metrics, keyframingCompletedAt: keyframeCompletedAt, providerSubmittedAt: keyframeCompletedAt } };
  await admin.from('video_versions').update({ brief_json: updatedBrief, updated_at: keyframeCompletedAt }).eq('id', version.id);
  return { id: version.id, status: 'generating' as const, processingStage: 'generating' as const, completedKeyframes, totalKeyframes: refreshedShots.length, keyframes: keyframePreviews, completedShots: 0, totalShots: refreshedShots.length };
}

export async function refreshLiveStoryboard(versionId: string, actor: Actor) {
  const admin = createStorageAdminClient();
  const { data: version, error } = await admin.from('video_versions')
    .select('id,video_id,status,final_path,error_message,updated_at,ai_model_id,fal_credential_id,brief_json,model:ai_models!inner(adapter_family,fal_endpoint_id,price_usd_per_second),video:videos!inner(id,user_id,brand_id,status)')
    .eq('id', versionId).single();
  if (error || !version) throw new HttpError(404, 'Cette version est introuvable.');
  const video = Array.isArray(version.video) ? version.video[0] : version.video;
  if (!video || video.user_id !== actor.id && actor.role !== 'admin') throw new HttpError(404, 'Cette version est introuvable.');
  if (version.status === 'ready' && version.final_path) return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, version.final_path) };
  if (version.status === 'cancelled') return { id: versionId, status: 'cancelled' as const, error: 'La génération a été annulée.' };
  if (version.status === 'failed') { await pruneRetiredFalCredentials(admin); return { id: versionId, status: 'failed' as const, error: version.error_message ?? 'Un plan n’a pas pu être généré.' }; }
  if (version.status === 'postprocessing' && actor.id !== 'cron-reconcile' && Date.now() - new Date(version.updated_at).getTime() < 60_000) {
    return { id: versionId, status: 'postprocessing' as const };
  }
  if (version.status === 'postprocessing') {
    const { data: claimed, error: claimError } = await admin.from('video_versions').update({ updated_at: new Date().toISOString() }).eq('id', versionId).eq('status', 'postprocessing').eq('updated_at', version.updated_at).select('id').maybeSingle();
    if (claimError) throw new HttpError(503, 'Impossible de réclamer la finalisation du montage.');
    if (!claimed) return { id: versionId, status: 'postprocessing' as const };
  }

  const { data: shots, error: shotsError } = await admin.from('video_shots')
    .select('shot_number,duration_seconds,title,generated_prompt,provider_request_id,provider_endpoint,status,raw_path,error_message,updated_at,keyframe_status,keyframe_request_id,keyframe_endpoint,keyframe_quality_request_id,keyframe_quality_endpoint,keyframe_path,keyframe_retry_count,keyframe_quality,keyframe_image_ledger_ids,keyframe_quality_ledger_ids,video_quality_status,video_quality_request_id,video_quality_endpoint,video_quality_retry_count,video_quality_ledger_ids,provider_poll_failure_count,provider_next_poll_at,provider_last_poll_error,provider_reconciliation_required,animation_submit_state,animation_submit_started_at')
    .eq('version_id', versionId).order('shot_number');
  const briefData = version.brief_json && typeof version.brief_json === 'object' ? version.brief_json as Record<string, unknown> : {};
  const singleStoryboardMode = briefData.singleStoryboardMode === true;
  if (shotsError || !shots || (singleStoryboardMode ? shots.length < 1 || shots.length > 6 : shots.length < 2 || shots.length > 6)) throw new HttpError(503, 'Les plans de cette vidéo sont introuvables.');
  const staleSubmissionCutoff = Date.now() - 5 * 60_000;
  const staleSubmissions = shots.filter((shot) => shot.animation_submit_state === 'submitting'
    && shot.animation_submit_started_at && new Date(shot.animation_submit_started_at).getTime() < staleSubmissionCutoff);
  if (staleSubmissions.length) await Promise.all(staleSubmissions.map((shot) => admin.from('video_shots').update({
    animation_submit_state: 'reconciliation', provider_reconciliation_required: true,
    provider_last_poll_error: 'La requête de soumission a dépassé le délai; vérifier le fournisseur avant toute nouvelle génération.',
    error_message: 'L’acceptation du plan par fal est incertaine. Le plan est en réconciliation et ne sera pas soumis une seconde fois automatiquement.',
    updated_at: new Date().toISOString(),
  }).eq('version_id', versionId).eq('shot_number', shot.shot_number).eq('animation_submit_state', 'submitting')));
  if (version.status === 'generating') {
    const { data: claimed, error: claimError } = await admin.from('video_versions').update({ updated_at: new Date().toISOString() }).eq('id', versionId).eq('status', 'generating').eq('updated_at', version.updated_at).select('id').maybeSingle();
    if (claimError) throw new HttpError(503, 'Impossible de réclamer le suivi des plans.');
    if (!claimed) return { id: versionId, status: 'generating' as const, completedShots: shots.filter((shot) => shot.status === 'ready').length, totalShots: shots.length };
  }
  const currentMetrics = briefData.processingMetrics && typeof briefData.processingMetrics === 'object' ? briefData.processingMetrics as ProcessingMetrics : {};
  const shotMetrics = briefData.shotProcessingMetrics && typeof briefData.shotProcessingMetrics === 'object' ? briefData.shotProcessingMetrics as Record<string, ProcessingMetrics> : {};
  const observedAt = new Date().toISOString();
  const nextShotMetrics = { ...shotMetrics };
  const model = Array.isArray(version.model) ? version.model[0] : version.model;
  const adapterFamily: 'wan' | 'kling' | 'seedance' = model?.adapter_family === 'wan' ? 'wan' : model?.adapter_family === 'seedance' ? 'seedance' : 'kling';
  const multiClip = version.brief_json && typeof version.brief_json === 'object' && (version.brief_json as { multiClipMode?: unknown }).multiClipMode === true;
  const keyframeMode = briefData.keyframeMode === true;
  const premiumQualityMode = briefData.videoQualityMode === true;
  const falCredential = await getFalCredentialById(version.fal_credential_id, admin);
  if (keyframeMode) {
    const keyframeResult = await refreshKeyframes({ admin, version, video, shots, actor, brief: briefData, apiKey: falCredential.apiKey, adapterFamily });
    if (keyframeResult) return keyframeResult;
  }
  const statusProvider = keyframeMode ? keyframeVideoProviders[adapterFamily] : multiClip || singleStoryboardMode ? providers[adapterFamily] : klingVideoProvider;
  const statusEndpoint = 'endpoint' in statusProvider ? statusProvider.endpoint : KLING_ENDPOINT;
  const retryEndpoint = 'endpoint' in statusProvider ? statusProvider.endpoint : KLING_ENDPOINT;

  if (premiumQualityMode) {
    const drafts = Array.isArray(briefData.storyboard) ? briefData.storyboard as StoryboardShot[] : [];
    const draftByNumber = new Map(drafts.map((draft, index) => [index + 1, draft]));
    const qualityChecks = await Promise.allSettled(shots.filter((shot) => shot.video_quality_status === 'checking' && shot.video_quality_request_id
      && Number(shot.provider_poll_failure_count ?? 0) < 4 && isFalPollDue(shot.provider_next_poll_at)).map(async (shot) => {
      const shotNumber = Number(shot.shot_number);
      const qualityLedgerIds = Array.isArray(shot.video_quality_ledger_ids) ? shot.video_quality_ledger_ids as string[] : [];
      const attempt = Math.min(1, Number(shot.video_quality_retry_count ?? 0));
      let qualityState;
      try {
        qualityState = await readKeyframeQuality(String(shot.video_quality_request_id), falCredential.apiKey, String(shot.video_quality_endpoint || KEYFRAME_VISION_ENDPOINT));
      } catch (cause) {
        await recordPollFailure({ admin, versionId, shotNumber, shot, stage: 'video_quality', cause, apiKey: falCredential.apiKey, now: new Date().toISOString() });
        return;
      }
      if (qualityState.status === 'checking') return;
      const ledgerId = qualityLedgerIds[attempt];
      if (qualityState.status === 'failed' || !qualityState.quality) {
        if (qualityState.costUsd !== null && ledgerId) await settleQualityLedger(admin, ledgerId, qualityState.costUsd);
        await admin.from('video_shots').update({ status: 'failed', video_quality_status: 'failed', provider_reconciliation_required: qualityState.costUsd === null, error_message: 'Le contrôle qualité du clip a échoué; le plan ne sera pas inclus dans le montage.', updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shotNumber);
        return;
      }
      const quality = qualityState.quality;
      const videoQualityDecision = videoQualityAction(quality.approved, attempt);
      if (ledgerId) await settleQualityLedger(admin, ledgerId, qualityState.costUsd ?? KEYFRAME_QUALITY_RESERVE_USD);
      if (videoQualityDecision === 'accept') {
        if (attempt === 0 && qualityLedgerIds[1]) await settleUsageCost(admin, { entryId: qualityLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        await admin.from('video_shots').update({ status: 'ready', video_quality_status: 'passed', video_quality: quality, provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, provider_reconciliation_required: false, error_message: null, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shotNumber);
        return;
      }
      if (videoQualityDecision === 'reject') {
        await admin.from('video_shots').update({ status: 'failed', video_quality_status: 'failed', video_quality: quality, error_message: `Échec qualité après une reprise : ${quality.issues.join('; ') || quality.reason}`, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shotNumber);
        return;
      }
      const draft = draftByNumber.get(shotNumber);
      if (!draft || typeof shot.keyframe_path !== 'string') throw new HttpError(503, `Impossible de reprendre le plan ${shotNumber} : référence image manquante.`);
      const { data: keyframe, error: keyframeError } = await admin.storage.from('videos').createSignedUrl(shot.keyframe_path, 3600);
      if (keyframeError || !keyframe?.signedUrl) throw new HttpError(503, `Impossible de préparer la reprise du plan ${shotNumber}.`);
      const { data: retryClaim, error: retryClaimError } = await admin.from('video_shots').update({ animation_submit_state: 'submitting', animation_submit_started_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shotNumber).eq('animation_submit_state', 'submitted').eq('video_quality_retry_count', 0).select('shot_number').maybeSingle();
      if (retryClaimError) throw new HttpError(503, `Impossible de verrouiller la reprise du plan ${shotNumber}.`);
      if (!retryClaim) return;
      const retryPrompt = buildKeyframeAnimationPrompt({
        shot: draft, vehicle: String(briefData.vehicle_description ?? 'Véhicule de référence'), durationS: Number(shot.duration_seconds),
        mood: String(briefData.mood ?? ''), lighting: String(briefData.lighting ?? ''), excludePeople: shouldExcludePeople(String(briefData.character ?? ''), String(briefData.user_direction ?? '')),
        retryReason: quality.issues.join('; ') || quality.reason,
      });
      let retryJob: { requestId: string };
      try {
        retryJob = await (statusProvider as ReferenceVideoProvider).submit({ prompt: retryPrompt, referenceImageUrls: [keyframe.signedUrl], durationS: Number(shot.duration_seconds), aspectRatio: String(briefData.format ?? '16:9'), endUserId: String(video.user_id) }, falCredential.apiKey);
      } catch (cause) {
        const statusCode = falErrorStatusCode(cause);
        const uncertain = statusCode === null || statusCode >= 500;
        if (!uncertain && qualityLedgerIds[1]) await settleUsageCost(admin, { entryId: qualityLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        await admin.from('video_shots').update({ status: 'failed', animation_submit_state: animationSubmitStateAfterFailure(statusCode), video_quality_status: 'failed', provider_reconciliation_required: uncertain, provider_last_poll_error: safeProviderError(cause, falCredential.apiKey), error_message: uncertain ? 'La reprise qualité n’a pas été confirmée par fal; vérification requise avant toute nouvelle soumission.' : `fal a refusé la reprise qualité (${statusCode}).`, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shotNumber);
        return;
      }
      const retryPatch = { status: 'generating', animation_submit_state: 'submitted', video_quality_status: 'retrying', video_quality: quality, video_quality_previous_path: shot.raw_path, video_quality_retry_count: 1, provider_request_id: retryJob.requestId, provider_endpoint: retryEndpoint, generated_prompt: retryPrompt, provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, provider_reconciliation_required: false, error_message: null, updated_at: new Date().toISOString() };
      const retryWrite = await admin.from('video_shots').update(retryPatch).eq('version_id', versionId).eq('shot_number', shotNumber);
      if (retryWrite.error) {
        const recoveredWrite = await admin.from('video_shots').update(retryPatch).eq('version_id', versionId).eq('shot_number', shotNumber);
        if (recoveredWrite.error) await admin.from('video_shots').update({ status: 'failed', animation_submit_state: 'reconciliation', video_quality_status: 'failed', provider_reconciliation_required: true, provider_last_poll_error: `request_id=${retryJob.requestId}`, error_message: 'fal a accepté la reprise, mais son identifiant n’a pas pu être enregistré. Vérification requise.', updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shotNumber);
      }
    }));
    const qualityFailure = qualityChecks.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (qualityFailure) throw qualityFailure.reason;
  }

  const shotRefreshResults = await Promise.allSettled(shots.filter((shot) => shot.status === 'generating' && shot.provider_request_id
    && Number(shot.provider_poll_failure_count ?? 0) < 4 && isFalPollDue(shot.provider_next_poll_at)).map(async (shot) => {
    let state;
    try {
      state = await statusProvider.status(shot.provider_request_id, falCredential.apiKey, String(shot.provider_endpoint || statusEndpoint));
    } catch (cause) {
      logFalStatusFailure({ stage: 'storyboard_shot_status', versionId, shotNumber: shot.shot_number, providerRequestId: shot.provider_request_id, endpoint: String(shot.provider_endpoint || statusEndpoint), adapterFamily, cause, apiKey: falCredential.apiKey });
      await recordPollFailure({ admin, versionId, shotNumber: Number(shot.shot_number), shot, stage: 'video', cause, apiKey: falCredential.apiKey, now: new Date().toISOString() });
      return;
    }
    if (Number(shot.provider_poll_failure_count ?? 0) > 0) {
      await admin.from('video_shots').update({ provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null }).eq('version_id', versionId).eq('shot_number', shot.shot_number);
    }
    if (state.status === 'failed') {
      nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'failedAt', observedAt);
      await admin.from('video_shots').update({ status: 'failed', provider_reconciliation_required: true, provider_next_poll_at: null, provider_last_poll_error: state.error ?? 'fal task failed', error_message: `${state.error ?? 'La génération fal a échoué.'} Son coût reste à réconcilier.`, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shot.shot_number).eq('status', 'generating');
      return;
    }
    if (state.status === 'queued') nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'providerQueuedAt', observedAt);
    if (state.status === 'generating') nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'generationStartedAt', observedAt);
    if (state.status !== 'ready' || !state.videoUrl) return;
    nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'providerCompletedAt', observedAt);
    const parsed = acceptedFalUrl(state.videoUrl);
    if (!parsed) throw new HttpError(502, 'Le fournisseur a retourné une URL vidéo non autorisée.');
    const response = await fetch(parsed, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new HttpError(502, `Impossible de récupérer le plan ${shot.shot_number}.`);
    const bytes = await readBoundedVideo(response, MAX_VIDEO_BYTES);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new HttpError(502, `Le plan ${shot.shot_number} n’est pas un MP4 valide.`);
    const clipAttempt = Number(shot.video_quality_retry_count ?? 0);
    const rawPath = `${version.video_id}/${versionId}/shot-${shot.shot_number}${clipAttempt ? `-retry-${clipAttempt}` : ''}.mp4`;
    const { error: uploadError } = await admin.storage.from('videos').upload(rawPath, bytes, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new HttpError(502, `Impossible d’enregistrer le plan ${shot.shot_number}.`);
    if (premiumQualityMode) {
      const shotNumber = Number(shot.shot_number);
      const draft = Array.isArray(briefData.storyboard) ? (briefData.storyboard as StoryboardShot[])[shotNumber - 1] : undefined;
      const referenceMap = Array.isArray(briefData.keyframeReferencesByShot) ? briefData.keyframeReferencesByShot as Array<{ shotNumber: number; assetIds: string[] }> : [];
      const referenceIds = referenceMap.find((entry) => entry.shotNumber === shotNumber)?.assetIds ?? (draft ? [draft.vehiclePhotoId, ...(draft.locationPhotoId ? [draft.locationPhotoId] : [])] : []);
      const placeId = draft?.locationPhotoId;
      const vehicleIds = referenceIds.filter((id) => id !== placeId);
      const { data: refAssets, error: refError } = vehicleIds.length
        ? await admin.from('assets').select('id,path,kind,status,brand_id').in('id', vehicleIds).eq('kind', 'vehicle').eq('status', 'validée').eq('brand_id', video.brand_id)
        : { data: [], error: null };
      const curatedPlace = placeId ? findCuratedLocation(placeId) : undefined;
      const placeAsset = placeId && !curatedPlace ? (await admin.from('assets').select('id,path,kind,status,brand_id').eq('id', placeId).eq('kind', 'place').eq('status', 'validée').eq('brand_id', video.brand_id).maybeSingle()).data : null;
      if (!draft || refError || (refAssets ?? []).length !== vehicleIds.length || placeId && !curatedPlace && !placeAsset) throw new HttpError(422, `Les références du plan ${shotNumber} ne sont plus accessibles pour son contrôle qualité.`);
      const frameBytes = await extractRepresentativeVideoFrames(bytes);
      const falStorage = createFalClient({ credentials: falCredential.apiKey }).storage;
      const frameUrls = await Promise.all(frameBytes.map((frame) => falStorage.upload(new Blob([frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer], { type: 'image/jpeg' }), { lifecycle: { expiresIn: '1d' } })));
      const assets = new Map((refAssets ?? []).map((asset) => [asset.id, asset]));
      const referencePaths = [...vehicleIds.map((id) => assets.get(id)?.path), ...(placeId ? [curatedPlace?.path ?? placeAsset?.path] : [])];
      const referenceUrls = await Promise.all(referencePaths.map((path) => path ? resolveFalAssetUrl(path, admin, falStorage, new Map()) : Promise.reject(new HttpError(422, 'Une référence qualité est introuvable.'))));
      const visionPrompt = `${buildVideoQualityPrompt({ vehicleReferenceCount: vehicleIds.length, hasLocationReference: Boolean(placeId), excludePeople: shouldExcludePeople(String(briefData.character ?? ''), String(briefData.user_direction ?? '')) })} Shot: ${draft.title}; scene: ${draft.scene}; framing: ${draft.framing}; location: ${draft.location}.`;
      let qualityJob: { requestId: string };
      try {
        qualityJob = await submitKeyframeQuality({ prompt: visionPrompt, imageUrls: [...frameUrls, ...referenceUrls] }, falCredential.apiKey);
      } catch (cause) {
        const statusCode = falErrorStatusCode(cause);
        const uncertain = statusCode === null || statusCode >= 500;
        const qualityLedgerIds = Array.isArray(shot.video_quality_ledger_ids) ? shot.video_quality_ledger_ids as string[] : [];
        if (!uncertain && qualityLedgerIds[0]) await settleUsageCost(admin, { entryId: qualityLedgerIds[0], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        if (qualityLedgerIds[1]) await settleUsageCost(admin, { entryId: qualityLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        await admin.from('video_shots').update({ status: 'failed', raw_path: rawPath, video_quality_status: 'failed', provider_reconciliation_required: uncertain, provider_last_poll_error: safeProviderError(cause, falCredential.apiKey), actual_cost_usd: Number(shot.duration_seconds) * Number(model?.price_usd_per_second ?? 0) * (Number(shot.video_quality_retry_count ?? 0) + 1), error_message: uncertain ? 'fal n’a pas confirmé si le contrôle du clip a été accepté; le montage reste bloqué pour réconciliation.' : `fal a refusé le contrôle du clip (${statusCode}); le plan ne sera pas monté.`, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shotNumber).eq('status', 'generating');
        return;
      }
      const updateQuality = await admin.from('video_shots').update({ status: 'postprocessing', raw_path: rawPath, video_quality_status: 'checking', video_quality_request_id: qualityJob.requestId, video_quality_endpoint: KEYFRAME_VISION_ENDPOINT, actual_cost_usd: Number(shot.duration_seconds) * Number(model?.price_usd_per_second ?? 0) * (Number(shot.video_quality_retry_count ?? 0) + 1), provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, provider_reconciliation_required: false, error_message: null, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shotNumber).eq('status', 'generating');
      if (updateQuality.error) {
        const patch = { status: 'postprocessing', raw_path: rawPath, video_quality_status: 'checking', video_quality_request_id: qualityJob.requestId, video_quality_endpoint: KEYFRAME_VISION_ENDPOINT, actual_cost_usd: Number(shot.duration_seconds) * Number(model?.price_usd_per_second ?? 0) * (Number(shot.video_quality_retry_count ?? 0) + 1), provider_poll_failure_count: 0, provider_next_poll_at: null, provider_last_poll_error: null, provider_reconciliation_required: false, error_message: null, updated_at: new Date().toISOString() };
        const recoveredWrite = await admin.from('video_shots').update(patch).eq('version_id', versionId).eq('shot_number', shotNumber).eq('status', 'generating');
        if (recoveredWrite.error) await admin.from('video_shots').update({ status: 'failed', video_quality_status: 'failed', raw_path: rawPath, provider_reconciliation_required: true, provider_last_poll_error: `request_id=${qualityJob.requestId}`, error_message: 'fal a accepté le contrôle du clip, mais son identifiant n’a pas pu être enregistré. Vérification manuelle nécessaire.', updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shotNumber);
      }
    } else {
      await admin.from('video_shots').update({ status: 'ready', raw_path: rawPath, actual_cost_usd: Number(shot.duration_seconds) * Number(model?.price_usd_per_second ?? 0), error_message: null, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shot.shot_number).eq('status', 'generating');
    }
    nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'rawStoredAt', new Date().toISOString());
  }));

  const observedShots = latestMetricsForShots(shots, nextShotMetrics, observedAt);
  let metrics = { ...currentMetrics };
  const firstGeneration = observedShots.map((entry) => entry.generationStartedAt).filter((value): value is string => Boolean(value)).sort()[0];
  if (firstGeneration) metrics.generationStartedAt = metrics.generationStartedAt ?? firstGeneration;
  const allSettled = observedShots.length > 0 && observedShots.every((entry) => entry.providerCompletedAt || entry.failedAt);
  const lastCompleted = observedShots.map((entry) => entry.providerCompletedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  if (allSettled && lastCompleted) metrics.providerCompletedAt = metrics.providerCompletedAt ?? lastCompleted;
  const lastStored = observedShots.map((entry) => entry.rawStoredAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  if (allSettled && lastStored) metrics.rawStoredAt = metrics.rawStoredAt ?? lastStored;
  const lastFailed = observedShots.map((entry) => entry.failedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  if (allSettled && lastFailed) metrics.failedAt = metrics.failedAt ?? lastFailed;
  const mergedBrief = { ...briefData, processingMetrics: metrics, shotProcessingMetrics: nextShotMetrics };
  const { error: metricsSaveError } = await admin.from('video_versions').update({ brief_json: mergedBrief }).eq('id', versionId);
  if (metricsSaveError) console.error('Impossible d’enregistrer les durées des plans:', metricsSaveError.message);
  const refreshFailure = shotRefreshResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (refreshFailure) throw refreshFailure.reason;

  const { data: latestShots, error: latestError } = await admin.from('video_shots').select('shot_number,title,status,raw_path,duration_seconds,actual_cost_usd,video_quality_status,video_quality_retry_count,video_quality_ledger_ids,provider_reconciliation_required,provider_poll_failure_count,provider_next_poll_at').eq('version_id', versionId).order('shot_number');
  if (latestError || !latestShots) throw new HttpError(503, 'Impossible de relire l’état des plans.');
  const completedShots = latestShots.filter((shot) => shot.status === 'ready' && shot.raw_path).length;
  const reconciliationRequired = latestShots.some((shot) => shot.provider_reconciliation_required);
  if (reconciliationRequired) return { id: versionId, status: 'generating' as const, reconciliationRequired: true, error: 'Une tâche fal doit être réconciliée avec son identifiant fournisseur avant la clôture des coûts.', completedShots, totalShots: latestShots.length };
  const pendingShots = latestShots.some((shot) => ['queued','generating','postprocessing'].includes(shot.status) || premiumQualityMode && ['queued','checking','retrying'].includes(shot.video_quality_status));
  const shotProgress = latestShots.map((shot) => ({ number: shot.shot_number, title: shot.title, status: shot.status, qualityStatus: shot.video_quality_status }));
  const scheduledPolls = latestShots.map((shot) => shot.provider_next_poll_at ? Math.max(1, Math.ceil((new Date(shot.provider_next_poll_at).getTime() - Date.now()) / 1000)) : null).filter((seconds): seconds is number => seconds !== null);
  const nextPollInSeconds = scheduledPolls.length ? Math.min(...scheduledPolls) : 15;
  if (pendingShots) return { id: versionId, status: 'generating' as const, completedShots, totalShots: latestShots.length, checkedQualityShots: latestShots.filter((shot) => shot.video_quality_status === 'passed').length, totalQualityShots: premiumQualityMode ? latestShots.length : 0, shotProgress: premiumQualityMode ? shotProgress : undefined, processingStage: latestShots.some((shot) => shot.video_quality_status === 'checking') ? 'quality_checking' as const : 'generating' as const, nextPollInSeconds };

  if (premiumQualityMode) {
    const unusedClipQualityReservations = latestShots.flatMap((shot) => {
      const ids = Array.isArray(shot.video_quality_ledger_ids) ? shot.video_quality_ledger_ids : [];
      const usedAttempts = shot.video_quality_status === 'passed' || shot.video_quality_status === 'failed'
        ? Number(shot.video_quality_retry_count ?? 0) + 1
        : 0;
      return ids.slice(usedAttempts).map(String);
    });
    await Promise.all(unusedClipQualityReservations.map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false })));
  }

  const { data: ledger, error: ledgerError } = await admin.from('usage_ledger').select('id,status').eq('version_id', versionId).eq('kind', 'generation').eq('ai_model_id', version.ai_model_id).maybeSingle();
  if (ledgerError) throw new HttpError(503, 'Impossible de clôturer le budget des plans.');
  const priceUsdPerSecond = Number(model.price_usd_per_second);
  if (ledger?.status === 'reserved') {
    metrics = firstObservedAt(metrics, 'costsSettlementStartedAt', new Date().toISOString());
    const { error: billingStartError } = await admin.from('video_versions').update({ brief_json: { ...mergedBrief, processingMetrics: metrics } }).eq('id', versionId);
    if (billingStartError) console.error('Impossible d’enregistrer le début de clôture des coûts:', billingStartError.message);
    const outcome = latestShots.some((shot) => Boolean(shot.raw_path)) ? 'charged' : 'released';
    const actualCostUsd = latestShots.filter((shot) => shot.raw_path).reduce((sum, shot) => sum + Number(shot.actual_cost_usd ?? Number(shot.duration_seconds) * priceUsdPerSecond), 0);
    const actualSeconds = latestShots.filter((shot) => shot.raw_path).reduce((sum, shot) => sum + (priceUsdPerSecond > 0 ? Number(shot.actual_cost_usd ?? 0) / priceUsdPerSecond : Number(shot.duration_seconds) * (Number(shot.video_quality_retry_count ?? 0) + 1)), 0);
    const { error: settleError } = await settleUsageCost(admin, {
      entryId: ledger.id, outcome, actualCostUsd, actualSeconds, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
    });
    if (settleError) throw new HttpError(503, 'La consommation fal doit être réconciliée avant de terminer le montage.');
  }
  metrics.costsSettledAt = metrics.costsSettledAt ?? new Date().toISOString();
  metrics.postproductionStartedAt = metrics.postproductionStartedAt ?? new Date().toISOString();
  await admin.from('video_versions').update({ brief_json: { ...mergedBrief, processingMetrics: metrics } }).eq('id', versionId);
  if (completedShots !== latestShots.length) {
    const qualityRejected = latestShots.some((shot) => shot.video_quality_status === 'failed');
    const errorMessage = qualityRejected ? 'Un plan a échoué au contrôle qualité après une reprise. La vidéo finale n’a pas été assemblée.' : 'Un plan a échoué. Relancez la vidéo pour obtenir le montage complet.';
    await Promise.all([
      admin.from('video_versions').update({ status: 'failed', error_message: errorMessage, updated_at: new Date().toISOString() }).eq('id', versionId),
      admin.from('videos').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', version.video_id),
    ]);
    await pruneRetiredFalCredentials(admin);
    return { id: versionId, status: 'failed' as const, error: errorMessage, completedShots, totalShots: latestShots.length, checkedQualityShots: latestShots.filter((shot) => shot.video_quality_status === 'passed').length, totalQualityShots: premiumQualityMode ? latestShots.length : 0, shotProgress: premiumQualityMode ? shotProgress : undefined };
  }

  if (version.status !== 'postprocessing') {
    await admin.from('video_versions').update({ status: 'postprocessing', updated_at: new Date().toISOString() }).eq('id', versionId);
  }
  try {
    const { finalPath } = await assembleShotMontage(versionId);
    await pruneRetiredFalCredentials(admin);
    return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, finalPath), completedShots: latestShots.length, totalShots: latestShots.length };
  } catch (cause) {
    return { id: versionId, status: 'postprocessing' as const, error: cause instanceof Error ? cause.message : 'Le montage sera repris automatiquement.', completedShots: latestShots.length, totalShots: latestShots.length };
  }
}

async function signedUrl(admin: ReturnType<typeof createStorageAdminClient>, path: string) {
  try { return await serverVideoObjects(admin).createReadUrl(path, { expiresIn: 3600 }); }
  catch { throw new HttpError(503, 'Impossible de créer le lien temporaire du montage.'); }
}

function latestMetricsForShots(shots: Array<{ shot_number: number }>, byShot: Record<string, ProcessingMetrics>, fallbackAt: string) {
  return shots.map((shot) => byShot[String(shot.shot_number)] ?? { requestedAt: fallbackAt });
}

function acceptedFalUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'fal.media' || host.endsWith('.fal.media') || host === 'storage.googleapis.com') ? url : null;
  } catch { return null; }
}

async function readBoundedImage(response: Response, limit: number) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'L’image-clé dépasse la taille autorisée.');
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, 'Le fournisseur n’a pas retourné de fichier image.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'L’image-clé dépasse la taille autorisée.'); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const isPng = bytes.toString('hex', 0, 4) === '89504e47';
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (bytes.length < 12 || !(isPng || isJpeg || isWebp)) {
    throw new HttpError(502, 'Le fichier image retourné par le fournisseur est invalide.');
  }
  return bytes;
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
