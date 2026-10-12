import type { Actor } from '@/core/auth/guards';
import { briefToPrompt, buildBrief } from '@/core/brief';
import type { Brief } from '@/core/brief';
import { klingVideoProvider, KLING_ENDPOINT } from '@/core/providers/fal-kling';
import { wanVideoProvider, WAN_ENDPOINT } from '@/core/providers/fal-wan';
import { veoVideoProvider, VEO_ENDPOINT } from '@/core/providers/fal-veo';
import { seedanceVideoProvider, SEEDANCE_ENDPOINT } from '@/core/providers/fal-seedance';
import { buildFalBriefWithCost, FalLlmBriefError } from '@/core/providers/fal-llm';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { env, effectiveBudgetCapEur } from '@/env';
import { HttpError } from '@/core/auth/guards';
import type { z } from 'zod';
import { requestSchema } from './request-schema';
import { beginPostproduction, retryPostproduction } from '@/core/postproduction/pipeline';
import { getScenePreset } from '@/core/scenes/catalog';
import { calculateClientPriceFcfa } from '@/core/pricing';
import { createLiveStoryboard, refreshLiveStoryboard } from './storyboard-live';

export type CreateVersionInput = z.infer<typeof requestSchema>;

export async function createLiveVersion(actor: Actor, input: CreateVersionInput, options?: { modelId?: string; reuse?: { brief: Brief; prompt: string } }) {
  if (input.storyboard) return createLiveStoryboard(actor, input as CreateVersionInput & { storyboard: import('@/core/storyboard').StoryboardShot[] });
  if (input.tier === 'test' && actor.role !== 'admin') throw new HttpError(403, 'Le niveau Test est réservé à l’administrateur.');
  if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');

  const authenticated = await createSupabaseServerClient();
  const admin = createStorageAdminClient();
  const expectedTier = input.tier;
  const expectedEndpoint = input.tier === 'standard'
    ? input.durationS === 5 ? WAN_ENDPOINT : KLING_ENDPOINT
    : input.durationS === 5 ? VEO_ENDPOINT : SEEDANCE_ENDPOINT;
  const [{ data: asset, error: assetError }, { data: model, error: modelError }] = await Promise.all([
    authenticated.from('assets').select('id,kind,path,make,model,color,status,brand_id').eq('id', input.assetId).single(),
    admin.from('ai_models').select('id,name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default').eq(options?.modelId ? 'id' : 'fal_endpoint_id', options?.modelId ?? expectedEndpoint).eq('is_active', true).single(),
  ]);
  if (assetError || !asset || asset.kind !== 'vehicle' || asset.status !== 'validée' || asset.brand_id !== actor.brandId) throw new HttpError(422, 'Choisissez une photo de véhicule validée pour votre marque.');
  if (input.audioAssetId) {
    const { data: audio, error: audioError } = await authenticated.from('assets').select('id,kind,status,brand_id').eq('id', input.audioAssetId).single();
    if (audioError || !audio || audio.kind !== 'audio' || audio.status !== 'validée' || audio.brand_id !== actor.brandId) throw new HttpError(422, 'Choisissez une piste audio validée pour votre marque.');
  }
  if (modelError || !model || !['kling','wan','veo','seedance'].includes(model.adapter_family)) throw new HttpError(503, 'Le modèle demandé n’est pas activé ou ne dispose pas d’un adaptateur live.');
  const endpointMatches = model.adapter_family === 'kling' && model.fal_endpoint_id === KLING_ENDPOINT
    || model.adapter_family === 'wan' && model.fal_endpoint_id === WAN_ENDPOINT
    || model.adapter_family === 'veo' && model.fal_endpoint_id === VEO_ENDPOINT
    || model.adapter_family === 'seedance' && model.fal_endpoint_id === SEEDANCE_ENDPOINT;
  if (!endpointMatches) throw new HttpError(503, 'L’identifiant d’endpoint ne correspond pas à l’adaptateur vidéo activé.');
  if (model.fal_endpoint_id !== expectedEndpoint) throw new HttpError(422, 'Le modèle ne correspond pas au niveau et à la durée demandés.');
  if (options?.modelId && model.tier !== expectedTier) throw new HttpError(422, 'Le niveau demandé ne correspond pas au modèle sélectionné.');
  const sourceDurationS = model.adapter_family === 'veo' ? 6 : input.durationS;
  const storedDurations = model.adapter_family === 'veo' ? [5, 6] : model.allowed_durations ?? [];
  if (!storedDurations.includes(input.durationS) || model.adapter_family === 'kling' && input.durationS > 15 || model.adapter_family === 'seedance' && input.durationS > 30 || model.adapter_family === 'wan' && input.durationS !== 5) throw new HttpError(422, 'La durée choisie n’est pas disponible pour ce modèle.');
  if (!model.allowed_formats?.includes(input.format)) throw new HttpError(422, `Le modèle ne prend pas en charge le format ${input.format}.`);

  const { data: image, error: imageError } = await admin.storage.from('assets').createSignedUrl(asset.path, 3600);
  if (imageError || !image?.signedUrl) throw new HttpError(422, 'Impossible de préparer la photo sélectionnée.');
  const vehicleDescription = [asset.make, asset.model, asset.color].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
  if (input.scenePresetId && !getScenePreset(input.scenePresetId)) throw new HttpError(422, 'La scène sélectionnée est introuvable.');
  const briefOptions = { vehicle_asset_id: asset.id, vehicle_description: vehicleDescription || 'Véhicule strictement identique à la photo de référence', vehicle_category: input.vehicleCategory, scene_preset_id: input.scenePresetId, vehicle_action: input.vehicleAction, user_direction: input.description, location: input.location, setting: input.setting, character: input.character || 'Aucun personnage', lighting: input.lighting, camera_movement: input.cameraMovement, mood: input.mood, format: input.format, duration_s: input.durationS, complexity: input.complexity };
  const llmBriefOptions = Object.fromEntries(Object.entries(briefOptions).map(([key, value]) => [key, String(value)]));
  const initialBrief = options?.reuse?.brief ?? buildBrief(input.description || 'Vidéo automobile réaliste et élégante.', briefOptions);
  if (initialBrief.vehicle_asset_id !== asset.id || initialBrief.format !== input.format) throw new HttpError(422, 'Le brief commun ne correspond pas à la photo ou au format sélectionné.');
  const estimatedProviderCostUsd = sourceDurationS * Number(model.price_usd_per_second);
  const priceFcfa = calculateClientPriceFcfa(estimatedProviderCostUsd, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);
  const fcfaPerSecond = priceFcfa / input.durationS;

  const videoTitle = input.title || `${asset.make ?? ''} ${asset.model ?? 'Véhicule'} · Nouvelle création`.trim();
  const { data: video, error: videoError } = await admin.from('videos').insert({ user_id: actor.id, brand_id: actor.brandId, title: videoTitle, department: actor.department, status: 'generating' }).select('id').single();
  if (videoError || !video) throw new HttpError(500, 'Impossible de créer la vidéo. Réessayez.');
  const { data: version, error: versionError } = await admin.from('video_versions').insert({ video_id: video.id, number: 1, brief_json: initialBrief, generated_prompt: '', ai_model_id: model.id, audio_asset_id: input.audioAssetId ?? null, status: 'queued', generation_seconds: input.durationS }).select('id,number').single();
  if (versionError || !version) {
    await admin.from('videos').delete().eq('id', video.id);
    throw new HttpError(500, 'Impossible de créer la version de la vidéo. Réessayez.');
  }
  const { data: ledgerId, error: reserveError } = await admin.rpc('reserve_budget', {
    p_user_id: actor.id, p_version_id: version.id, p_model_id: model.id, p_seconds: sourceDurationS,
    p_price_usd_second: Number(model.price_usd_per_second), p_usd_to_eur: env.USD_TO_EUR_RATE,
    p_eur_to_fcfa: env.EUR_TO_FCFA, p_price_fcfa: priceFcfa, p_cap_eur: effectiveBudgetCapEur,
    p_department: actor.department, p_applied_fcfa_second: fcfaPerSecond,
  });
  if (reserveError || !ledgerId) {
    await Promise.all([admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
    throw new HttpError(reserveError?.message.includes('Plafond') ? 409 : 503, reserveError?.message.includes('Plafond') ? 'Le plafond de coût réel est atteint. Aucune génération n’a été lancée.' : 'Impossible de réserver le budget pour cette génération.');
  }

  const llmReserveUsd = 2 * (env.LLM_MAX_COST_USD ?? 0);
  let brief: Brief;
  let prompt: string;
  if (options?.reuse) {
    brief = options.reuse.brief;
    prompt = options.reuse.prompt;
  } else {
  let llmCallCompleted = false;
  let llmReportedCostUsd: number | null = null;
  const { data: llmLedgerId, error: llmReserveError } = await admin.rpc('reserve_llm_budget', {
    p_user_id: actor.id, p_version_id: version.id, p_max_cost_usd: llmReserveUsd,
    p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA,
    p_cap_eur: effectiveBudgetCapEur, p_department: actor.department,
  });
  if (llmReserveError || !llmLedgerId) {
    await Promise.all([
      admin.rpc('settle_budget', { p_entry_id: ledgerId, p_outcome: 'released', p_actual_cost_usd: 0, p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA, p_cap_eur: effectiveBudgetCapEur }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Le plafond ne permet pas de réserver le brief LLM.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(llmReserveError?.message.includes('Plafond') ? 409 : 503, llmReserveError?.message.includes('Plafond') ? 'Le plafond de coût réel est atteint. Aucune requête LLM n’a été lancée.' : 'Impossible de réserver le budget du brief LLM.');
  }

  try {
    const generated = await buildFalBriefWithCost(input.description, llmBriefOptions);
    llmCallCompleted = true;
    llmReportedCostUsd = generated.costUsd;
    brief = generated.brief as Brief;
    if (!model.allowed_formats?.includes(brief.format)) throw new HttpError(422, `Le modèle ne prend pas en charge le format ${brief.format}.`);
    prompt = briefToPrompt(brief, model.adapter_family);
    const { error: settleError } = await admin.rpc('settle_budget', { p_entry_id: llmLedgerId, p_outcome: 'charged', p_actual_cost_usd: generated.costUsd ?? llmReserveUsd, p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA, p_cap_eur: effectiveBudgetCapEur });
    if (settleError) throw new HttpError(503, 'Le coût du brief LLM doit être réconcilié avant de lancer la vidéo.');
    const { error: briefUpdateError } = await admin.from('video_versions').update({ brief_json: brief, generated_prompt: prompt }).eq('id', version.id);
    if (briefUpdateError) throw new HttpError(503, 'Le brief est facturé mais n’a pas pu être enregistré. Réessayez depuis l’administration.');
  } catch (briefError) {
    const message = briefError instanceof HttpError ? briefError.message : 'Le brief n’a pas pu être préparé. Vérifiez le fournisseur LLM puis réessayez.';
    if (!(briefError instanceof HttpError && message.startsWith('Le coût du brief LLM'))) {
      const completedRequests = briefError instanceof FalLlmBriefError ? briefError.completedRequests : 0;
      const reportedCostUsd = llmReportedCostUsd ?? (briefError instanceof FalLlmBriefError ? briefError.reportedCostUsd : null);
      const completed = llmCallCompleted || completedRequests > 0;
      await admin.rpc('settle_budget', {
        p_entry_id: llmLedgerId,
        p_outcome: completed ? 'charged' : 'released',
        p_actual_cost_usd: completed ? reportedCostUsd ?? llmReserveUsd : 0,
        p_usd_to_eur: env.USD_TO_EUR_RATE,
        p_eur_to_fcfa: env.EUR_TO_FCFA,
        p_cap_eur: effectiveBudgetCapEur,
      });
    }
    await Promise.all([
      admin.rpc('settle_budget', { p_entry_id: ledgerId, p_outcome: 'released', p_actual_cost_usd: 0, p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA, p_cap_eur: effectiveBudgetCapEur }),
      admin.from('video_versions').update({ status: 'failed', error_message: message }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(502, message);
  }
  }

  let requestId: string;
  try {
    const provider = model.adapter_family === 'wan' ? wanVideoProvider : model.adapter_family === 'veo' ? veoVideoProvider : model.adapter_family === 'seedance' ? seedanceVideoProvider : klingVideoProvider;
    ({ requestId } = await provider.submit({ prompt, imageUrl: image.signedUrl, durationS: sourceDurationS as 5 | 6 | 10 | 15 | 20 | 30, format: input.format, endUserId: actor.id }));
  } catch {
    await Promise.all([
      admin.rpc('settle_budget', { p_entry_id: ledgerId, p_outcome: 'released', p_actual_cost_usd: 0, p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA, p_cap_eur: effectiveBudgetCapEur }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Impossible de soumettre la génération au fournisseur.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Impossible de démarrer la génération vidéo. Le budget réservé a été libéré.');
  }
  const { error: updateError } = await admin.from('video_versions').update({ provider_request_id: requestId, status: 'generating' }).eq('id', version.id);
  if (updateError) throw new HttpError(503, 'La génération a démarré, mais son suivi n’a pas pu être enregistré. Le budget reste réservé.');
  return { id: version.id, status: 'generating' as const, brief, prompt, estimatedPriceFcfa: priceFcfa, version: version.number };
}

function acceptedFalUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'fal.media' || host.endsWith('.fal.media') || host === 'storage.googleapis.com')) return null;
    return url;
  } catch { return null; }
}

export async function refreshLiveVersion(versionId: string, actor: Actor) {
  const admin = createStorageAdminClient();
  const { data: version, error } = await admin.from('video_versions').select('id,video_id,number,provider_request_id,status,raw_path,final_path,updated_at,brief_json,model:ai_models!inner(adapter_family),video:videos!inner(id,user_id,status,brand_id,department)').eq('id', versionId).single();
  if (error || !version) throw new HttpError(404, 'Cette version est introuvable.');
  const video = Array.isArray(version.video) ? version.video[0] : version.video;
  const ownsVideo = video?.user_id === actor.id;
  const canReview = actor.role === 'valideur' && video?.status === 'review' && video.brand_id === actor.brandId && video.department === actor.department;
  if (!video || !ownsVideo && !canReview && actor.role !== 'admin') throw new HttpError(404, 'Cette version est introuvable.');
  if (version.brief_json && typeof version.brief_json === 'object' && 'storyboard' in version.brief_json) return refreshLiveStoryboard(versionId, actor);
  if (version.status === 'failed') return { id: versionId, status: version.status };
  if (version.status === 'ready') {
    if (video.status === 'generating' && version.final_path) {
      const { error: readyError } = await admin.from('videos').update({ status: 'ready' }).eq('id', version.video_id);
      if (readyError) throw new HttpError(503, 'Le fichier final est prêt; son état doit être réconcilié.');
      video.status = 'ready';
    }
    const approvedFinal = (video?.status === 'approved' || video?.status === 'ready' && ownsVideo) && version.final_path;
    const validatorPreview = video?.status === 'review' && (actor.role === 'admin' || actor.role === 'valideur' && video.brand_id === actor.brandId && video.department === actor.department);
    const path = approvedFinal || validatorPreview ? approvedFinal || version.final_path : null;
    return { id: versionId, status: version.status, videoUrl: path ? await signedVideoUrl(admin, path) : undefined };
  }
  if (version.status === 'postprocessing') {
    if (actor.id !== 'cron-reconcile') return { id: versionId, status: 'postprocessing' as const };
    return retryPostproduction(versionId, admin);
  }
  if (!version.provider_request_id) throw new HttpError(409, 'La demande de génération n’a pas encore été enregistrée.');
  const model = Array.isArray(version.model) ? version.model[0] : version.model;
  const provider = model?.adapter_family === 'wan' ? wanVideoProvider : model?.adapter_family === 'veo' ? veoVideoProvider : model?.adapter_family === 'seedance' ? seedanceVideoProvider : klingVideoProvider;
  const status = await provider.status(version.provider_request_id);
  let rawPath = version.raw_path as string | null;
  if (status.status === 'ready' && status.videoUrl) {
    const parsed = acceptedFalUrl(status.videoUrl);
    if (!parsed) throw new HttpError(502, 'Le fournisseur a retourné une URL vidéo non autorisée.');
    const response = await fetch(parsed, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new HttpError(502, 'Impossible de récupérer la vidéo générée.');
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 100 * 1024 * 1024) throw new HttpError(502, 'La vidéo générée dépasse la taille autorisée.');
    const bytes = await readBoundedVideo(response, 100 * 1024 * 1024);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new HttpError(502, 'Le fichier reçu n’est pas une vidéo MP4 valide ou dépasse la taille autorisée.');
    rawPath = `${version.video_id}/${versionId}/raw.mp4`;
    const { error: uploadError } = await admin.storage.from('videos').upload(rawPath, bytes, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new HttpError(502, 'Impossible de sauvegarder la vidéo dans la médiathèque sécurisée.');
  }
  if (status.status === 'ready') {
    const { data: ledger } = await admin.from('usage_ledger').select('id,cost_usd').eq('version_id', versionId).eq('status', 'reserved').maybeSingle();
    if (ledger) {
      const { error: settleError } = await admin.rpc('settle_budget', { p_entry_id: ledger.id, p_outcome: 'charged', p_actual_cost_usd: ledger.cost_usd, p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA, p_cap_eur: effectiveBudgetCapEur });
      if (settleError) throw new HttpError(503, 'La vidéo est générée mais la clôture du budget doit être réconciliée par l’administrateur.');
    }
  }
  if (status.status === 'failed') {
    const { data: ledger } = await admin.from('usage_ledger').select('id').eq('version_id', versionId).eq('status', 'reserved').maybeSingle();
    if (ledger) {
      const { error: settleError } = await admin.rpc('settle_budget', { p_entry_id: ledger.id, p_outcome: 'released', p_actual_cost_usd: 0, p_usd_to_eur: env.USD_TO_EUR_RATE, p_eur_to_fcfa: env.EUR_TO_FCFA, p_cap_eur: effectiveBudgetCapEur });
      if (settleError) throw new HttpError(503, 'La réservation de budget doit être réconciliée par l’administrateur.');
    }
  }
  const updates: Record<string, unknown> = { status: status.status };
  if (rawPath) updates.raw_path = rawPath;
  if (status.error) updates.error_message = status.error;
  if (status.status === 'ready') { updates.status = 'postprocessing'; updates.updated_at = new Date().toISOString(); }
  // A queued version can already have a Fal request ID when the initial
  // submission was only partially persisted. Reconcile either in-flight state
  // so a completed Fal result is not downloaded repeatedly and left unprocessed.
  const { data: claimedVersion, error: updateError } = await admin.from('video_versions').update(updates).eq('id', versionId).in('status', ['queued', 'generating']).select('id').maybeSingle();
  if (updateError) throw new HttpError(503, 'Impossible d’enregistrer le nouvel état de génération.');
  if (status.status === 'ready') {
    if (!claimedVersion) return { id: versionId, status: 'postprocessing' as const };
    try {
      const processed = await beginPostproduction(versionId);
      const canDownload = ownsVideo || actor.role === 'admin';
      return { id: versionId, status: processed.status, videoUrl: canDownload ? await signedVideoUrl(admin, processed.finalPath) : undefined };
    } catch (postprodError) {
      const message = postprodError instanceof HttpError ? postprodError.message : 'La post-production a échoué.';
      await Promise.all([
        admin.from('video_versions').update({ status: 'failed', error_message: message }).eq('id', versionId),
        admin.from('videos').update({ status: 'failed' }).eq('id', version.video_id),
      ]);
      return { id: versionId, status: 'failed' as const, error: message };
    }
  }
  if (status.status === 'failed') await admin.from('videos').update({ status: 'failed' }).eq('id', version.video_id);
  return { id: versionId, status: status.status, error: status.error };
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
async function signedVideoUrl(admin: ReturnType<typeof createStorageAdminClient>, path: string) {
  const { data, error } = await admin.storage.from('videos').createSignedUrl(path, 3600);
  if (error) throw new HttpError(503, 'Impossible de créer le lien temporaire de la vidéo.');
  return data.signedUrl;
}
