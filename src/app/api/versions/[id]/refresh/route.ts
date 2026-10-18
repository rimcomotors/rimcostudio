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
      const processingStageName = processingStage(version?.status ?? result.status, metrics);
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
