import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { allVersions, putVersion } from '@/core/versions/store';
import { createFalClient } from '@fal-ai/client';
import { getFalCredentialById, pruneRetiredFalCredentials } from '@/core/providers/fal-credential-vault';
import { env } from '@/env';
import { KEYFRAME_IMAGE_ENDPOINT, KEYFRAME_VISION_ENDPOINT, KEYFRAME_VIDEO_ENDPOINTS } from '@/core/providers/fal-keyframes';
import { KLING_REFERENCE_ENDPOINT, SEEDANCE_REFERENCE_ENDPOINT, WAN_REFERENCE_ENDPOINT } from '@/core/providers/fal-reference-video';
import { KLING_ENDPOINT } from '@/core/providers/fal-kling';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getActor();
    const { id } = await context.params;
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      const current = allVersions().find((item) => item.id === id);
      if (!current || actor.role !== 'admin' && current.userId !== actor.id) throw new HttpError(404, 'Génération introuvable.');
      if (!['queued', 'generating'].includes(current.status)) throw new HttpError(409, 'Cette génération ne peut plus être annulée.');
      putVersion({ ...current, status: 'cancelled' });
      return NextResponse.json({ id, status: 'cancelled' });
    }
    const admin = createStorageAdminClient();
    const { data: version, error } = await admin.from('video_versions').select('id,status,video_id,provider_request_id,fal_credential_id,brief_json,model:ai_models(fal_endpoint_id,adapter_family),video:videos!inner(user_id,status)').eq('id', id).single();
    if (error || !version) throw new HttpError(404, 'Génération introuvable.');
    const video = Array.isArray(version.video) ? version.video[0] : version.video;
    if (!video || actor.role !== 'admin' && video.user_id !== actor.id) throw new HttpError(403, 'Cette génération ne vous appartient pas.');
    if (!['queued', 'generating'].includes(version.status)) throw new HttpError(409, 'Cette génération ne peut plus être annulée.');
    const now = new Date().toISOString();
    const model = Array.isArray(version.model) ? version.model[0] : version.model;
    const adapterFamily = model?.adapter_family === 'wan' ? 'wan' : model?.adapter_family === 'seedance' ? 'seedance' : 'kling';
    const keyframeMode = Boolean(version.brief_json && typeof version.brief_json === 'object' && (version.brief_json as Record<string, unknown>).keyframeMode === true);
    const adapterEndpoint = keyframeMode ? KEYFRAME_VIDEO_ENDPOINTS[adapterFamily] : adapterFamily === 'wan' ? WAN_REFERENCE_ENDPOINT : adapterFamily === 'seedance' ? SEEDANCE_REFERENCE_ENDPOINT : adapterFamily === 'kling' ? KLING_REFERENCE_ENDPOINT : KLING_ENDPOINT;
    if (version.provider_request_id && model?.fal_endpoint_id) {
      try {
        const credential = await getFalCredentialById(version.fal_credential_id, admin);
        await createFalClient({ credentials: credential.apiKey }).queue.cancel(model.fal_endpoint_id, { requestId: version.provider_request_id });
      } catch {
        // Cancellation may already have completed remotely; never log provider errors or credentials.
        console.warn('Annulation Fal non confirmée.');
      }
    }
    const { data: shots } = await admin.from('video_shots').select('provider_request_id,provider_endpoint,keyframe_request_id,keyframe_endpoint,keyframe_quality_request_id,keyframe_quality_endpoint,usage_ledger_id,keyframe_retry_count,keyframe_image_ledger_ids,keyframe_quality_ledger_ids,provider_reconciliation_required').eq('version_id', id);
    if (shots?.length) {
      try {
        const credential = await getFalCredentialById(version.fal_credential_id, admin);
        const fal = createFalClient({ credentials: credential.apiKey });
        const cancellations: Array<Promise<void>> = [];
        for (const shot of shots) {
          if (shot.keyframe_request_id) cancellations.push(fal.queue.cancel(shot.keyframe_endpoint || KEYFRAME_IMAGE_ENDPOINT, { requestId: shot.keyframe_request_id }));
          if (shot.keyframe_quality_request_id) cancellations.push(fal.queue.cancel(shot.keyframe_quality_endpoint || KEYFRAME_VISION_ENDPOINT, { requestId: shot.keyframe_quality_request_id }));
          if (shot.provider_request_id) cancellations.push(fal.queue.cancel(shot.provider_endpoint || adapterEndpoint, { requestId: shot.provider_request_id }));
        }
        await Promise.allSettled(cancellations);
      } catch { console.warn('Annulation Fal des plans non confirmée.'); }
    }
    const { error: versionUpdateError } = await admin.from('video_versions').update({ status: 'cancelled', error_message: 'Annulée par l’utilisateur.', updated_at: now }).eq('id', id).in('status', ['queued', 'generating']);
    if (versionUpdateError) throw versionUpdateError;
    await admin.from('videos').update({ status: 'cancelled', updated_at: now }).eq('id', version.video_id);
    const uncertainCost = (shots ?? []).some((shot) => shot.provider_reconciliation_required);
    const providerBackedLedgerIds = new Set<string>();
    for (const shot of shots ?? []) {
      const attempt = Math.min(1, Number(shot.keyframe_retry_count ?? 0));
      const imageIds = Array.isArray(shot.keyframe_image_ledger_ids) ? shot.keyframe_image_ledger_ids : [];
      const qualityIds = Array.isArray(shot.keyframe_quality_ledger_ids) ? shot.keyframe_quality_ledger_ids : [];
      if (shot.keyframe_request_id && typeof imageIds[attempt] === 'string') providerBackedLedgerIds.add(imageIds[attempt]);
      if (shot.keyframe_quality_request_id && typeof qualityIds[attempt] === 'string') providerBackedLedgerIds.add(qualityIds[attempt]);
      if (shot.provider_request_id && typeof shot.usage_ledger_id === 'string') providerBackedLedgerIds.add(shot.usage_ledger_id);
    }
    const { data: reservations } = await admin.from('usage_ledger').select('id').eq('version_id', id).eq('status', 'reserved');
    if (!uncertainCost) {
      await Promise.all((reservations ?? []).filter((entry) => !providerBackedLedgerIds.has(entry.id)).map((entry) =>
        admin.from('usage_ledger').update({ status: 'released' }).eq('id', entry.id).eq('status', 'reserved'),
      ));
    }
    await admin.from('notifications').upsert({ user_id: video.user_id, version_id: id, type: 'cancelled', message: 'La génération a été annulée.' }, { onConflict: 'user_id,version_id,type', ignoreDuplicates: true });
    await pruneRetiredFalCredentials(admin);
    return NextResponse.json({ id, status: 'cancelled' });
  } catch (error) { return errorResponse(error); }
}
