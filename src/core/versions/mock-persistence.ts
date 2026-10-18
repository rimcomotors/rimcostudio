import type { Actor } from '@/core/auth/guards';
import { HttpError } from '@/core/auth/guards';
import { briefToPrompt, buildBrief } from '@/core/brief';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { supabaseServiceKey } from '@/env';
import { env } from '@/env';
import { mockStatusAt } from './mock-status';
import type { CreateVersionInput } from './live';
import { calculateClientPriceFcfa } from '@/core/pricing';
import { getSceneConceptDirection } from '@/core/scenes/concepts';
import { getScenePreset, inferVehicleCategory } from '@/core/scenes/catalog';
import { reserveGenerationCost, settleUsageCost } from '@/core/billing/ledger';
import { approveCompletedAdminVideo } from '@/core/versions/approval';
import { refreshLivePhotoFidelity } from '@/core/versions/photo-fidelity';

export const MOCK_VIDEO_PATH = 'mock/mock-video.mp4';

export async function createPersistedMockVersion(actor: Actor, input: CreateVersionInput) {
  if (!supabaseServiceKey) throw new HttpError(503, 'Le mode mock avec Supabase exige SUPABASE_SERVICE_ROLE_KEY ou SUPABASE_SECRET_KEY.');
  if (!actor.brandId) throw new HttpError(403, 'Votre profil doit être associé à une marque avant de créer une vidéo.');
  const admin = createStorageAdminClient();
  const authenticated = await createSupabaseServerClient();
  const { data: asset, error: assetError } = await authenticated.from('assets').select('id,kind,status,brand_id,make,model').eq('id', input.assetId).single();
  if (assetError || !asset || asset.kind !== 'vehicle' || asset.status !== 'validée' || asset.brand_id !== actor.brandId) throw new HttpError(422, 'Choisissez une photo de véhicule validée pour votre marque.');
  if (input.audioAssetId) {
    const { data: audio, error: audioError } = await authenticated.from('assets').select('id,kind,status,brand_id').eq('id', input.audioAssetId).single();
    if (audioError || !audio || audio.kind !== 'audio' || audio.status !== 'validée' || audio.brand_id !== actor.brandId) throw new HttpError(422, 'Choisissez une piste audio validée pour votre marque.');
  }
  const tier = input.tier === 'test' ? 'premium' : input.tier;
  const { data: model, error: modelError } = await admin.from('ai_models').select('id,price_usd_per_second').eq('tier', tier).eq('is_default', true).eq('is_active', true).single();
  if (modelError || !model) throw new HttpError(503, `Aucun modèle par défaut actif n’est configuré pour le niveau ${tier}.`);
  const priceFcfa = calculateClientPriceFcfa(5 * Number(model.price_usd_per_second), env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);
  const selectedScene = input.scenePresetId ? getScenePreset(input.scenePresetId) : undefined;
  const userDirection = [getSceneConceptDirection(selectedScene, input.conceptId), input.description].filter(Boolean).join(' ').slice(0, 500);
  const brief = buildBrief(userDirection || 'Vidéo automobile réaliste et élégante.', { vehicle_asset_id: input.assetId, vehicle_category: inferVehicleCategory(asset.make, asset.model), scene_preset_id: input.scenePresetId, vehicle_action: selectedScene?.vehicleAction ?? input.vehicleAction, user_direction: userDirection, camera_movement: selectedScene?.cameraMovement ?? input.cameraMovement, mood: selectedScene?.mood ?? input.mood, location: selectedScene?.location ?? input.location, setting: selectedScene?.setting ?? input.setting, character: input.character || selectedScene?.character || 'Aucun personnage', lighting: selectedScene?.lighting ?? input.lighting, format: input.format, duration_s: input.durationS, complexity: input.complexity });
  const prompt = briefToPrompt(brief, 'mock');
  const title = input.title || `${brief.vehicle_description.slice(0, 90)} · Simulation`;
  const { data: video, error: videoError } = await admin.from('videos').insert({ user_id: actor.id, brand_id: actor.brandId, title, department: actor.department, status: 'generating' }).select('id').single();
  if (videoError || !video) throw new HttpError(503, 'Impossible de créer la simulation persistante. Vérifiez la configuration Supabase.');
  const { data: version, error: versionError } = await admin.from('video_versions').insert({
    video_id: video.id, number: 1, brief_json: { ...brief, generationTier: tier, overlayLogo: input.overlayLogo, mock_metadata: { priceFcfa, provider: 'mock' } }, audio_asset_id: input.audioAssetId ?? null,
    generated_prompt: prompt, ai_model_id: model.id, provider_request_id: `mock:${crypto.randomUUID()}`, status: 'queued', generation_seconds: 5,
  }).select('id,number,created_at').single();
  if (versionError || !version) {
    await admin.from('videos').delete().eq('id', video.id);
    throw new HttpError(503, 'Impossible de créer la simulation. Réessayez.');
  }
  const { data: ledgerId, error: ledgerError } = await reserveGenerationCost(admin, {
    userId: actor.id, versionId: version.id, modelId: model.id, seconds: 5,
    // Simulation never reaches fal.ai, so it must not reserve provider budget.
    priceUsdPerSecond: 0, usdToEur: env.USD_TO_EUR_RATE,
    eurToFcfa: env.EUR_TO_FCFA, priceFcfa, department: actor.department,
  });
  if (ledgerError || !ledgerId) {
    await admin.from('videos').delete().eq('id', video.id);
    throw new HttpError(503, 'Impossible de réserver le suivi de coût simulé. La génération a été annulée.');
  }
  const { error: settleError } = await settleUsageCost(admin, { entryId: ledgerId, outcome: 'charged', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA });
  if (settleError) throw new HttpError(503, 'La simulation est créée, mais son coût doit être réconcilié dans le journal.');
  return { id: version.id, status: 'queued' as const, prompt, estimatedPriceFcfa: priceFcfa, version: version.number };
}

export async function refreshPersistedMockVersion(versionId: string, actor: Actor) {
  if (!supabaseServiceKey) throw new HttpError(503, 'Le mode mock avec Supabase exige SUPABASE_SERVICE_ROLE_KEY ou SUPABASE_SECRET_KEY.');
  const admin = createStorageAdminClient();
  const { data: version, error } = await admin.from('video_versions')
    .select('id,video_id,status,raw_path,created_at,brief_json,video:videos!inner(id,user_id,status,brand_id,department)')
    .eq('id', versionId).single();
  if (error || !version) throw new HttpError(404, 'Cette version est introuvable.');
  const video = Array.isArray(version.video) ? version.video[0] : version.video;
  const owns = video?.user_id === actor.id;
  const canReview = actor.role === 'valideur' && video?.status === 'review' && video.brand_id === actor.brandId && video.department === actor.department;
  if (!video || !owns && !canReview && actor.role !== 'admin') throw new HttpError(404, 'Cette version est introuvable.');
  if (version.brief_json && typeof version.brief_json === 'object' && (version.brief_json as Record<string, unknown>).photoFidelityMode === true) return refreshLivePhotoFidelity(versionId, actor);
  if (version.status === 'failed') return { id: versionId, status: 'failed' as const };
  if (version.status === 'ready') {
    if (actor.role === 'admin' && video.status !== 'approved') {
      await approveCompletedAdminVideo(admin, actor, { videoId: video.id, versionId });
    }
    return { id: versionId, status: 'ready' as const, videoUrl: '/mock/mock-video.mp4' };
  }

  const status = mockStatusAt(version.created_at);
  const updates: { status: string; raw_path?: string } = { status };
  if (status === 'ready') updates.raw_path = MOCK_VIDEO_PATH;
  const { error: updateError } = await admin.from('video_versions').update(updates).eq('id', versionId);
  if (updateError) throw new HttpError(503, 'Impossible d’enregistrer l’état de la simulation.');
  if (status === 'ready' && video.status !== 'ready' && video.status !== 'approved') {
    if (actor.role === 'admin') {
      await approveCompletedAdminVideo(admin, actor, { videoId: video.id, versionId });
    } else {
      const { error: videoError } = await admin.from('videos').update({ status: 'ready' }).eq('id', video.id);
      if (videoError) throw new HttpError(503, 'La génération est prête; son état doit être réconcilié.');
    }
  }
  return { id: versionId, status, ...(status === 'ready' ? { videoUrl: '/mock/mock-video.mp4' } : {}) };
}
