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
import { createSignedVideoDownloadUrl } from '@/core/storage/signed-video';
import { getScenePreset } from '@/core/scenes/catalog';

export async function GET(request: Request) {
  try {
    const actor = await getActor();
    const requestedStatus = new URL(request.url).searchParams.get('status');
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      const records = allVersions().filter((item) => item.userId === actor.id || actor.role === 'admin');
      const versions = records.map((latest) => {
        const status = latest.reviewStatus === 'approved' ? 'ready' : latest.reviewStatus === 'rejected' ? 'rejected' : latest.reviewStatus === 'pending' ? 'review' : latest.status;
        return { id: latest.id, videoId: latest.videoId, title: latest.brief.vehicle_description, status, priceFcfa: latest.priceFcfa, prompt: latest.prompt, previewUrl: latest.status === 'ready' ? latest.videoUrl : undefined, videoUrl: latest.status === 'ready' ? latest.videoUrl : undefined, createdAt: latest.createdAt };
      }).filter((item) => !requestedStatus || item.status === requestedStatus);
      return NextResponse.json({ versions });
    }
    const admin = createStorageAdminClient();
    let query = admin.from('videos').select('id,user_id,title,status,department,brand_id,created_at,video_versions(id,number,status,final_path,raw_path,provider_request_id,brief_json,generated_prompt,created_at,error_message,validations(status),usage_ledger(price_fcfa))').order('created_at', { ascending: false });
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
      const canPreviewReview = video.status === 'review' && (actor.role === 'admin' || actor.role === 'valideur' && video.brand_id === actor.brandId && video.department === actor.department);
      const latestIsMock = latest?.provider_request_id?.startsWith('mock:') ?? false;
      const isOwner = video.user_id === actor.id;
      const path = video.status === 'approved' || video.status === 'ready' && isOwner ? latest?.final_path ?? (latestIsMock ? latest?.raw_path : null) : canPreviewReview || video.status === 'review' && isOwner ? latestIsMock ? latest?.raw_path : latest?.final_path : null;
      const briefData = latest?.brief_json && typeof latest.brief_json === 'object' ? latest.brief_json as Record<string, unknown> : {};
      const mockMetadata = briefData.mock_metadata && typeof briefData.mock_metadata === 'object' ? briefData.mock_metadata as Record<string, unknown> : {};
      const isPersistedMock = latest?.provider_request_id?.startsWith('mock:') ?? false;
      let videoUrl: string | null = null;
      let previewUrl: string | null = null;
      if (path && isPersistedMock) previewUrl = '/mock/mock-video.mp4';
      else if (path) {
        const storage = admin.storage.from('videos');
        const { data: signed } = await storage.createSignedUrl(path, 3600);
        previewUrl = signed?.signedUrl ?? null;
        if (video.status === 'approved' || video.status === 'ready' && isOwner) {
          videoUrl = await createSignedVideoDownloadUrl((storagePath, expiresIn, options) => storage.createSignedUrl(storagePath, expiresIn, options), path);
        }
      }
      if ((video.status === 'approved' || video.status === 'ready' && isOwner) && isPersistedMock) videoUrl = previewUrl;
      const status = video.status === 'approved' ? 'ready' : video.status === 'rejected' ? 'rejected' : video.status === 'review' ? 'review' : video.status === 'ready' ? 'ready' : latest?.status === 'failed' ? 'failed' : latest?.status === 'queued' || latest?.status === 'generating' || latest?.status === 'postprocessing' ? 'generating' : 'draft';
      const retryablePostproduction = latest?.status === 'failed' && Boolean(latest.raw_path) && typeof latest.error_message === 'string' && latest.error_message.startsWith('Impossible de démarrer FFmpeg');
      return { id: latest?.id ?? video.id, videoId: video.id, title: video.title, status, versionStatus: latest?.status ?? null, retryablePostproduction, priceFcfa: ledgerRows[0] ? Number(ledgerRows[0].price_fcfa) : typeof mockMetadata.priceFcfa === 'number' ? mockMetadata.priceFcfa : null, validationStatus: validationRows[0]?.status ?? null, prompt: latest?.generated_prompt ?? null, videoUrl, previewUrl, createdAt: video.created_at };
    }));
    return NextResponse.json({ versions: requestedStatus ? versions.filter((version) => version.status === requestedStatus) : versions });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const actor = await getActor();
    const input = requestSchema.parse(await request.json());
    if (input.scenePresetId && !getScenePreset(input.scenePresetId)) throw new HttpError(422, 'La scène sélectionnée est introuvable.');
    if (env.PROVIDERS_MODE === 'live') return NextResponse.json(await createLiveVersion(actor, input, { modelId: input.modelId }), { status: 201 });
    const brief = buildBrief(input.description || 'Vidéo automobile réaliste et élégante.', { vehicle_asset_id: input.assetId, vehicle_category: input.vehicleCategory, scene_preset_id: input.scenePresetId, vehicle_action: input.vehicleAction, user_direction: input.description, camera_movement: input.cameraMovement, mood: input.mood, location: input.location, setting: input.setting, character: input.character || 'Aucun personnage', lighting: input.lighting, format: input.format, duration_s: 5 });
    if (env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json(await createPersistedMockVersion(actor, input), { status: 201 });
    const prompt = briefToPrompt(brief, 'mock');
    const imageUrl = '/mock/vehicle.svg';
    const { requestId } = await mockVideoProvider.submit({ prompt, imageUrl, durationS: 5, format: input.format });
    const id = crypto.randomUUID();
    const record = putVersion({ id, videoId: crypto.randomUUID(), number: 1, userId: actor.id, brief, prompt, status: 'queued', requestId, priceFcfa: estimatePriceFcfa(5, input.tier), createdAt: new Date().toISOString() });
    return NextResponse.json({ id: record.id, status: record.status, prompt, estimatedPriceFcfa: record.priceFcfa, version: 1 }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
