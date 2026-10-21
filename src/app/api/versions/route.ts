import { NextResponse } from 'next/server';
import { briefToPrompt, buildBrief } from '@/core/brief';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { mockVideoProvider } from '@/core/providers/mock';
import { putVersion, allVersions } from '@/core/versions/store';
import { estimatePriceFcfa } from '@/core/pricing';
import { env } from '@/env';
import { requestSchema } from '@/core/versions/request-schema';
import { createLiveVersion } from '@/core/versions/live';
import { createPersistedMockVersion } from '@/core/versions/mock-persistence';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { collectVideoArtifactPaths } from '@/core/storage/intermediate-cleanup';
import { createSignedVideoDownloadUrl } from '@/core/storage/signed-video';
import { getScenePreset } from '@/core/scenes/catalog';
import { getSceneConceptDirection } from '@/core/scenes/concepts';
import { z } from 'zod';
import { deleteVersionsByVideoIds } from '@/core/versions/store';
import { aggregateGenerationCost } from '@/core/billing/aggregate';
import { isTierDurationSupported, photoFidelityShotSchema, singleShotStoryboardSchema, storyboardSchema, validatePhotoFidelityPlan, validatePremiumTwentySecondStoryboard, validateSingleShotStoryboard, validateStoryboard } from '@/core/storyboard';
import { createLiveStoryboard } from '@/core/versions/storyboard-live';
import { createLivePhotoFidelity } from '@/core/versions/photo-fidelity';
import { getStoryboardModeRoute } from '@/core/providers/storyboard-routing';
import { resolveGenerationTier } from '@/core/versions/generation-tier';
import { elapsedSeconds, processingDurations, processingStage, type ProcessingMetrics } from '@/core/versions/processing-metrics';

const deleteSchema = z.object({ videoIds: z.array(z.string().uuid()).min(1).max(50) }).strict().refine((input) => new Set(input.videoIds).size === input.videoIds.length, { message: 'La sélection contient des doublons.' });
const multiClipSchema = requestSchema.extend({
  workflow: z.literal('multi_clip'),
  storyMode: z.enum(['standard', 'pro', 'premium']),
  clipDurationSeconds: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]),
  purpose: z.enum(['presentation', 'advertising']),
  vehicleDossierId: z.string().uuid(),
  placeIds: z.array(z.string().uuid()).max(12).default([]),
  storyboardLedgerIds: z.array(z.string().uuid()).max(20).default([]),
  storyboard: storyboardSchema,
}).strict().refine((input) => input.clipDurationSeconds >= 10 || input.placeIds.length <= 1, {
  message: 'Une seule référence de lieu est autorisée pour une vidéo de moins de 10 secondes.',
  path: ['placeIds'],
});
const singleStoryboardSchema = requestSchema.extend({
  workflow: z.literal('single_storyboard'),
  storyMode: z.enum(['standard', 'pro', 'premium']),
  clipDurationSeconds: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]),
  purpose: z.enum(['presentation', 'advertising']),
  vehicleDossierId: z.string().uuid(),
  placeIds: z.array(z.string().uuid()).max(12).default([]),
  storyboardLedgerIds: z.array(z.string().uuid()).max(20).default([]),
  storyboard: singleShotStoryboardSchema,
}).strict().refine((input) => input.placeIds.length <= 1, {
  message: 'Une vidéo en un seul plan utilise un seul lieu.',
  path: ['placeIds'],
});
const photoFidelitySchema = requestSchema.extend({
  workflow: z.literal('photo_fidelity'),
  storyMode: z.enum(['standard', 'pro', 'premium']),
  clipDurationSeconds: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]),
  vehicleDossierId: z.string().uuid(),
  placeIds: z.array(z.string().uuid()).min(1).max(12),
  storyboard: z.array(photoFidelityShotSchema).min(1).max(6),
}).strict();

export async function GET(request: Request) {
  try {
    const actor = await getActor();
    const queryParams = new URL(request.url).searchParams;
    const requestedStatus = queryParams.get('status');
    const includePreviews = queryParams.get('includePreviews') !== 'false';
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      const records = allVersions().filter((item) => item.userId === actor.id || actor.role === 'admin');
      const versions = records.map((latest) => {
        const status = latest.reviewStatus === 'approved' ? 'ready' : latest.reviewStatus === 'rejected' ? 'rejected' : latest.reviewStatus === 'pending' ? 'review' : latest.status;
        return { id: latest.id, videoId: latest.videoId, title: latest.title ?? latest.brief.vehicle_description, status, tier: latest.tier ?? null, durationSeconds: latest.brief.duration_s, priceFcfa: latest.priceFcfa, prompt: latest.prompt, previewUrl: latest.status === 'ready' ? latest.videoUrl : undefined, videoUrl: latest.status === 'ready' ? latest.videoUrl : undefined, createdAt: latest.createdAt };
      }).filter((item) => !requestedStatus || item.status === requestedStatus);
      return NextResponse.json({ versions });
    }
    const admin = createStorageAdminClient();
    let query = admin.from('videos').select('id,user_id,title,status,department,brand_id,created_at,video_versions(id,number,status,generation_seconds,final_path,raw_path,provider_request_id,brief_json,generated_prompt,error_message,created_at,validations(id,status),model:ai_models(tier),usage_ledger(kind,ai_model_id,seconds,cost_usd,billable_cost_usd,price_fcfa,status),video_shots(shot_number,title,provider_poll_failure_count,provider_reconciliation_required,provider_last_poll_error,video_quality_status,status))').order('created_at', { ascending: false });
    if (actor.role === 'collaborateur') query = query.eq('user_id', actor.id);
    if (actor.role === 'valideur') {
      if (!actor.brandId) return NextResponse.json({ versions: [] });
      query = query.eq('brand_id', actor.brandId).eq('department', actor.department).eq('status', 'review');
    }
    const { data, error } = await query;
    if (error) throw error;
    const versions = await Promise.all((data ?? []).map(async (video) => {
      const rows = Array.isArray(video.video_versions) ? video.video_versions : [];
      const latest = [...rows].sort((a, b) => b.number - a.number)[0];
      const validationRows = Array.isArray(latest?.validations) ? latest.validations : [];
      const ledgerRows = Array.isArray(latest?.usage_ledger) ? latest.usage_ledger : [];
      const generationCost = aggregateGenerationCost(ledgerRows, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);
      const canPreviewReview = video.status === 'review' && (actor.role === 'admin' || actor.role === 'valideur' && video.brand_id === actor.brandId && video.department === actor.department);
      const isOwner = video.user_id === actor.id;
      const canPreviewReady = video.status === 'approved' || video.status === 'ready' && (isOwner || actor.role === 'admin');
      const canPreview = canPreviewReady || canPreviewReview || video.status === 'review' && isOwner;
      const briefData = latest?.brief_json && typeof latest.brief_json === 'object' ? latest.brief_json as Record<string, unknown> : {};
      const model = Array.isArray(latest?.model) ? latest.model[0] : latest?.model;
      const isPhotoFidelity = briefData.photoFidelityMode === true;
      const generationTier = isPhotoFidelity ? null : resolveGenerationTier(briefData.generationTier ?? briefData.storyMode, model?.tier);
      const mockMetadata = briefData.mock_metadata && typeof briefData.mock_metadata === 'object' ? briefData.mock_metadata as Record<string, unknown> : {};
      const shotRows = Array.isArray(latest?.video_shots) ? [...latest.video_shots].sort((left, right) => Number(left.shot_number ?? 0) - Number(right.shot_number ?? 0)) : [];
      const checkedQualityShots = shotRows.filter((shot) => shot.video_quality_status === 'passed').length;
      const totalQualityShots = briefData.videoQualityMode === true ? shotRows.length : 0;
      const qualityCheckActive = shotRows.some((shot) => shot.video_quality_status === 'checking');
      const shotProgress = briefData.videoQualityMode === true ? shotRows.map((shot) => ({ number: shot.shot_number, title: shot.title, status: shot.status, qualityStatus: shot.video_quality_status })) : undefined;
      const canRetryTracking = shotRows.some((shot) => Number(shot.provider_poll_failure_count ?? 0) >= 4 && !shot.provider_reconciliation_required);
      const reconciliationRequired = shotRows.some((shot) => shot.provider_reconciliation_required);
      const pollError = shotRows.find((shot) => (Number(shot.provider_poll_failure_count ?? 0) >= 4 || shot.provider_reconciliation_required) && shot.provider_last_poll_error)?.provider_last_poll_error ?? null;
      const isPersistedMock = latest?.provider_request_id?.startsWith('mock:') ?? false;
      let videoUrl: string | null = null;
      let previewUrl: string | null = null;
      let previewSource: 'final' | 'raw' | null = null;
      const finalPath = latest?.final_path ?? null;
      const rawPath = latest?.raw_path ?? null;
      const storage = admin.storage.from('videos');
      if (includePreviews && canPreview && isPersistedMock && (finalPath || rawPath)) {
        previewUrl = '/mock/mock-video.mp4';
        previewSource = finalPath ? 'final' : 'raw';
      } else if (includePreviews && canPreview) {
        const previewPaths = [
          ...(finalPath ? [{ path: finalPath, source: 'final' as const }] : []),
          ...(rawPath && rawPath !== finalPath ? [{ path: rawPath, source: 'raw' as const }] : []),
        ];
        for (const candidate of previewPaths) {
          const { data: signed } = await storage.createSignedUrl(candidate.path, 3600);
          if (!signed?.signedUrl) continue;
          previewUrl = signed.signedUrl;
          previewSource = candidate.source;
          break;
        }
      }
      if (includePreviews && video.status === 'approved' && finalPath) {
        videoUrl = await createSignedVideoDownloadUrl((storagePath, expiresIn, options) => storage.createSignedUrl(storagePath, expiresIn, options), finalPath);
      }
      if (includePreviews && video.status === 'approved' && isPersistedMock && previewUrl) videoUrl = previewUrl;
      const status = video.status === 'approved' ? 'ready' : video.status === 'rejected' ? 'rejected' : video.status === 'review' ? 'review' : video.status === 'cancelled' ? 'cancelled' : video.status === 'ready' ? 'ready' : latest?.status === 'failed' ? 'failed' : latest?.status === 'cancelled' ? 'cancelled' : latest?.status === 'queued' || latest?.status === 'generating' || latest?.status === 'postprocessing' ? 'generating' : 'draft';
      const metrics = briefData.processingMetrics && typeof briefData.processingMetrics === 'object' ? briefData.processingMetrics as ProcessingMetrics : {};
      const stage = qualityCheckActive ? 'quality_checking' : processingStage(latest?.status ?? status, metrics);
      const stageStartedAt = stage === 'queued' ? metrics.providerSubmittedAt : stage === 'keyframing' ? metrics.keyframingStartedAt : stage === 'generating' ? metrics.generationStartedAt ?? metrics.providerSubmittedAt : stage === 'transferring' ? metrics.providerCompletedAt : stage === 'postprocessing' ? metrics.postproductionStartedAt : undefined;
      return { id: latest?.id ?? video.id, videoId: video.id, title: video.title, status, workflow: briefData.multiClipMode === true ? 'multi_clip' : 'single', tier: generationTier, photoFidelity: isPhotoFidelity, format: typeof briefData.format === 'string' ? briefData.format : '16:9', durationSeconds: Number(latest?.generation_seconds ?? generationCost?.seconds ?? 5), version: latest?.number ?? 1, versionStatus: latest?.status ?? null, errorMessage: latest?.error_message ?? null, pollError, canRetryTracking, reconciliationRequired, checkedQualityShots, totalQualityShots, shotProgress, processingStage: stage, stageElapsedSeconds: elapsedSeconds(stageStartedAt), processingDurations: processingDurations(metrics, latest?.status ?? status), processingMetrics: metrics, priceFcfa: generationCost?.priceFcfa ?? (typeof mockMetadata.priceFcfa === 'number' ? mockMetadata.priceFcfa : null), validationId: validationRows[0]?.id ?? null, validationStatus: validationRows[0]?.status ?? null, prompt: latest?.generated_prompt ?? null, ...(includePreviews ? { videoUrl, previewUrl, previewSource } : {}), createdAt: video.created_at, department: video.department, userId: video.user_id };
    }));
    return NextResponse.json({ versions: requestedStatus ? versions.filter((version) => version.status === requestedStatus) : versions });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const actor = await getActor();
    const payload = await request.json();
    if (payload && typeof payload === 'object' && 'workflow' in payload && payload.workflow === 'photo_fidelity') {
      const input = photoFidelitySchema.parse(payload);
      if (!isTierDurationSupported(input.storyMode, input.clipDurationSeconds)) throw new HttpError(422, 'Le niveau Premium est disponible uniquement en storyboard IA de quatre plans de 5 secondes.');
      if (input.storyMode === 'premium') throw new HttpError(422, 'Le niveau Premium utilise la génération IA avec quatre plans de 5 secondes.');
      validatePhotoFidelityPlan(input.storyboard, input.clipDurationSeconds);
      if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
        return NextResponse.json({ id: crypto.randomUUID(), status: 'ready', videoUrl: '/mock/mock-video.mp4', prompt: 'Simulation du montage à partir des photos sources.', estimatedPriceFcfa: 0, fidelityStatus: 'Simulation — aucune image générée par IA n’a été utilisée.' }, { status: 201 });
      }
      return NextResponse.json(await createLivePhotoFidelity(actor, input), { status: 201 });
    }
    if (payload && typeof payload === 'object' && 'workflow' in payload && payload.workflow === 'single_storyboard') {
      const single = singleStoryboardSchema.parse(payload);
      if (!isTierDurationSupported(single.storyMode, single.clipDurationSeconds)) throw new HttpError(422, 'Le niveau Premium est disponible uniquement en 20 secondes.');
      if (single.storyMode === 'premium') throw new HttpError(422, 'Le niveau Premium utilise quatre plans de 5 secondes, pas un plan unique.');
      validateSingleShotStoryboard(single.storyboard, single.clipDurationSeconds, getStoryboardModeRoute(single.storyMode).adapterFamily);
      if (single.tier !== single.storyMode) throw new HttpError(422, 'Le mode de génération doit correspondre au storyboard validé.');
      if (single.audioAssetId) throw new HttpError(422, 'Le storyboard est sans audio pour le moment.');
      if (env.PROVIDERS_MODE === 'mock') {
        return NextResponse.json({ id: crypto.randomUUID(), status: 'ready', videoUrl: '/mock/mock-video.mp4', prompt: 'Simulation du storyboard IA à un seul plan.', completedShots: 1, totalShots: 1, estimatedPriceFcfa: 0 }, { status: 201 });
      }
      return NextResponse.json(await createLiveStoryboard(actor, { ...single, workflow: 'single' }), { status: 201 });
    }
    if (payload && typeof payload === 'object' && 'workflow' in payload && payload.workflow === 'multi_clip') {
      const multi = multiClipSchema.parse(payload);
      if (!isTierDurationSupported(multi.storyMode, multi.clipDurationSeconds)) throw new HttpError(422, 'Le niveau Premium est disponible uniquement en 20 secondes.');
      if (multi.storyMode === 'premium') validatePremiumTwentySecondStoryboard(multi.storyboard);
      validateStoryboard(multi.storyboard, multi.clipDurationSeconds, getStoryboardModeRoute(multi.storyMode).adapterFamily);
      if (multi.audioAssetId) throw new HttpError(422, 'Le storyboard multi-plans est sans audio pour le moment.');
      if (env.PROVIDERS_MODE === 'mock') {
        return NextResponse.json({ id: crypto.randomUUID(), status: 'ready', videoUrl: '/mock/mock-video.mp4', prompt: 'Simulation du storyboard multi-plans.', completedShots: multi.storyboard.length, totalShots: multi.storyboard.length, estimatedPriceFcfa: 0 }, { status: 201 });
      }
      return NextResponse.json(await createLiveStoryboard(actor, multi), { status: 201 });
    }
    const input = requestSchema.parse(payload);
    if (input.tier === 'premium') throw new HttpError(422, 'Les créations Premium passent par le storyboard IA de quatre plans de 5 secondes.');
    if (env.PROVIDERS_MODE === 'mock' && input.durationS !== 5) throw new HttpError(422, 'Les durées longues sont disponibles uniquement sur un environnement de génération actif.');
    if (input.scenePresetId && !getScenePreset(input.scenePresetId)) throw new HttpError(422, 'La scène sélectionnée est introuvable.');
    const selectedScene = input.scenePresetId ? getScenePreset(input.scenePresetId) : undefined;
    const userDirection = [getSceneConceptDirection(selectedScene, input.conceptId), input.description].filter(Boolean).join(' ').slice(0, 500);
    if (env.PROVIDERS_MODE === 'live') return NextResponse.json(await createLiveVersion(actor, input, { modelId: input.modelId }), { status: 201 });
    const brief = buildBrief(userDirection || 'Vidéo automobile réaliste et élégante.', { vehicle_asset_id: input.assetId, vehicle_category: input.vehicleCategory, scene_preset_id: input.scenePresetId, vehicle_action: selectedScene?.vehicleAction ?? input.vehicleAction, user_direction: userDirection, camera_movement: selectedScene?.cameraMovement ?? input.cameraMovement, mood: selectedScene?.mood ?? input.mood, location: selectedScene?.location ?? input.location, setting: selectedScene?.setting ?? input.setting, character: input.character || selectedScene?.character || 'Aucun personnage', lighting: selectedScene?.lighting ?? input.lighting, format: input.format, duration_s: input.durationS, complexity: input.complexity });
    if (env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json(await createPersistedMockVersion(actor, input), { status: 201 });
    const prompt = briefToPrompt(brief, 'mock');
    const imageUrl = '/mock/mock-video.svg';
    const { requestId } = await mockVideoProvider.submit({ prompt, imageUrl, durationS: 5, format: input.format });
    const id = crypto.randomUUID();
    const record = putVersion({ id, videoId: crypto.randomUUID(), title: input.title || undefined, number: 1, userId: actor.id, brief, prompt, status: 'queued', requestId, priceFcfa: estimatePriceFcfa(5, input.tier), tier: input.tier, createdAt: new Date().toISOString() });
    return NextResponse.json({ id: record.id, status: record.status, prompt, estimatedPriceFcfa: record.priceFcfa, version: 1 }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const actor = await getActor();
    if (actor.role === 'valideur') throw new HttpError(403, 'Les valideurs ne peuvent pas supprimer de vidéos.');
    const parsed = deleteSchema.safeParse(await request.json());
    if (!parsed.success) throw new HttpError(422, 'Sélection de vidéos invalide. Choisissez jusqu’à 50 vidéos.');
    const { videoIds } = parsed.data;

    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      const selectedRecords = allVersions().filter((record) => videoIds.includes(record.videoId));
      if (selectedRecords.length !== videoIds.length || selectedRecords.some((record) => actor.role !== 'admin' && record.userId !== actor.id)) {
        throw new HttpError(404, 'Certaines vidéos sélectionnées sont introuvables. Actualisez la Bibliothèque.');
      }
      if (selectedRecords.some((record) => ['queued', 'generating', 'postprocessing'].includes(record.status))) {
        throw new HttpError(409, 'Une vidéo est encore en cours de génération et ne peut pas être supprimée.');
      }
      deleteVersionsByVideoIds(videoIds);
      return NextResponse.json({ deleted: videoIds.length });
    }

    const admin = createStorageAdminClient();
    let query = admin.from('videos').select('id,user_id,status,video_versions(id,status,raw_path,final_path)').in('id', videoIds);
    if (actor.role === 'collaborateur') query = query.eq('user_id', actor.id);
    const { data: videos, error: queryError } = await query;
    if (queryError) throw queryError;
    if (!videos || videos.length !== videoIds.length) {
      throw new HttpError(404, 'Certaines vidéos sélectionnées sont introuvables. Actualisez la Bibliothèque.');
    }
    const isInProgress = videos.some((video) => video.status === 'generating' ||
      (Array.isArray(video.video_versions) && video.video_versions.some((version) => ['queued', 'generating', 'postprocessing'].includes(version.status))));
    if (isInProgress) throw new HttpError(409, 'Une vidéo est encore en cours de génération et ne peut pas être supprimée.');

    const versionIds = videos.flatMap((video) => Array.isArray(video.video_versions) ? video.video_versions.map((version) => version.id) : []);
    const { data: shots, error: shotsError } = versionIds.length
      ? await admin.from('video_shots').select('raw_path,keyframe_path,video_quality_previous_path').in('version_id', versionIds)
      : { data: [], error: null };
    if (shotsError) throw new HttpError(503, 'Impossible de préparer le nettoyage des fichiers de plans. Aucune vidéo n’a été supprimée.');
    const paths = collectVideoArtifactPaths(
      videos.flatMap((video) => Array.isArray(video.video_versions) ? video.video_versions : []),
      shots ?? [],
    );
    if (paths.length) {
      const { error: storageError } = await admin.storage.from('videos').remove(paths);
      if (storageError) throw storageError;
    }
    let deleteQuery = admin.from('videos').delete().in('id', videoIds);
    if (actor.role === 'collaborateur') deleteQuery = deleteQuery.eq('user_id', actor.id);
    const { data: deletedRows, error: deleteError } = await deleteQuery.select('id');
    if (deleteError) throw deleteError;
    if ((deletedRows ?? []).length !== videoIds.length) throw new HttpError(409, 'La suppression n’a pas pu être appliquée à toute la sélection. Actualisez la Bibliothèque.');
    return NextResponse.json({ deleted: deletedRows.length });
  } catch (error) { return errorResponse(error); }
}
