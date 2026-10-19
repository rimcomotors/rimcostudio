import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { mockVideoProvider } from '@/core/providers/mock';
import { getVersion, putVersion } from '@/core/versions/store';
import { env } from '@/env';
import { refreshLiveVersion } from '@/core/versions/live';
import { refreshPersistedMockVersion } from '@/core/versions/mock-persistence';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { elapsedSeconds, processingDurations, processingStage, type ProcessingMetrics } from '@/core/versions/processing-metrics';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor();
    const { id } = await context.params;
    if (env.PROVIDERS_MODE === 'live') {
      const result = await refreshLiveVersion(id, actor);
      const admin = createStorageAdminClient();
      const { data: version } = await admin.from('video_versions').select('status,brief_json').eq('id', id).maybeSingle();
      const brief = version?.brief_json && typeof version.brief_json === 'object' ? version.brief_json as Record<string, unknown> : {};
      const metrics = brief.processingMetrics && typeof brief.processingMetrics === 'object' ? brief.processingMetrics as ProcessingMetrics : {};
      const processingStageName = 'processingStage' in result && result.processingStage === 'quality_checking' ? 'quality_checking' : processingStage(version?.status ?? result.status, metrics);
      const stageStartedAt = processingStageName === 'queued' ? metrics.providerSubmittedAt : processingStageName === 'keyframing' ? metrics.keyframingStartedAt : processingStageName === 'generating' ? metrics.generationStartedAt ?? metrics.providerSubmittedAt : processingStageName === 'transferring' ? metrics.providerCompletedAt : processingStageName === 'postprocessing' ? metrics.postproductionStartedAt : undefined;
      return NextResponse.json({ ...result, processingStage: processingStageName, stageElapsedSeconds: elapsedSeconds(stageStartedAt), processingDurations: processingDurations(metrics, version?.status ?? result.status) });
    }
    if (env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json(await refreshPersistedMockVersion(id, actor));
    const current = getVersion(id);
    if (!current || current.userId !== actor.id && actor.role !== 'admin') throw new HttpError(404, 'Cette version est introuvable.');
    if (current.status === 'ready' || current.status === 'failed') return NextResponse.json({ id, status: current.status, videoUrl: current.status === 'ready' ? current.videoUrl : undefined, error: current.error });
    const result = await mockVideoProvider.status(current.requestId);
    const updated = putVersion({ ...current, status: result.status, ...(result.status === 'ready' && actor.role === 'admin' ? { reviewStatus: 'approved' as const } : {}), ...(result.videoUrl ? { videoUrl: result.videoUrl } : {}), ...(result.error ? { error: result.error } : {}) });
    return NextResponse.json({ id, status: updated.status, videoUrl: updated.status === 'ready' ? updated.videoUrl : undefined, error: updated.error });
  } catch (error) { return errorResponse(error); }
}

/** Explicitly retry status polling for an existing fal request; this never submits a generation. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (env.PROVIDERS_MODE !== 'live') throw new HttpError(409, 'La reprise du suivi fal est disponible uniquement pour une génération réelle.');
    const actor = await getActor();
    const { id } = await context.params;
    const admin = createStorageAdminClient();
    const { data: version, error } = await admin.from('video_versions')
      .select('id,status,video:videos!inner(user_id)')
      .eq('id', id).maybeSingle();
    const video = Array.isArray(version?.video) ? version.video[0] : version?.video;
    if (error || !version || !video || actor.role !== 'admin' && video.user_id !== actor.id) throw new HttpError(404, 'Cette version est introuvable.');
    if (!['queued', 'generating'].includes(version.status)) throw new HttpError(409, 'Cette génération ne peut plus reprendre son suivi.');
    const { data: shots, error: shotsError } = await admin.from('video_shots')
      .select('shot_number,status,keyframe_status,provider_poll_failure_count,provider_reconciliation_required')
      .eq('version_id', id);
    if (shotsError) throw new HttpError(503, 'Impossible de vérifier les tâches fal.');
    const retryable = (shots ?? []).filter((shot) => Number(shot.provider_poll_failure_count ?? 0) >= 4 && !shot.provider_reconciliation_required
      && (shot.status === 'generating' || ['generating', 'checking'].includes(shot.keyframe_status)));
    if (!retryable.length) throw new HttpError(409, 'Aucune tâche ne peut reprendre son suivi sans nouvelle soumission.');
    const updates = await Promise.all(retryable.map((shot) => admin.from('video_shots')
      .update({ provider_poll_failure_count: 3, provider_next_poll_at: null, provider_last_poll_error: null })
      .eq('version_id', id).eq('shot_number', shot.shot_number).eq('provider_poll_failure_count', 4).eq('provider_reconciliation_required', false)));
    if (updates.some((result) => result.error)) throw new HttpError(503, 'Impossible de réinitialiser le suivi fal.');
    return NextResponse.json({ id, status: version.status, retriedPolling: retryable.length, generationResubmitted: false });
  } catch (error) { return errorResponse(error); }
}
