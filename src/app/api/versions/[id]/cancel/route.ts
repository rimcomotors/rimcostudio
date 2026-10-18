import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { allVersions, putVersion } from '@/core/versions/store';
import { createFalClient } from '@fal-ai/client';
import { getFalCredentialById, pruneRetiredFalCredentials } from '@/core/providers/fal-credential-vault';
import { env } from '@/env';

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
    const { data: version, error } = await admin.from('video_versions').select('id,status,video_id,provider_request_id,fal_credential_id,model:ai_models(fal_endpoint_id),video:videos!inner(user_id,status)').eq('id', id).single();
    if (error || !version) throw new HttpError(404, 'Génération introuvable.');
    const video = Array.isArray(version.video) ? version.video[0] : version.video;
    if (!video || actor.role !== 'admin' && video.user_id !== actor.id) throw new HttpError(403, 'Cette génération ne vous appartient pas.');
    if (!['queued', 'generating'].includes(version.status)) throw new HttpError(409, 'Cette génération ne peut plus être annulée.');
    const now = new Date().toISOString();
    const model = Array.isArray(version.model) ? version.model[0] : version.model;
    if (version.provider_request_id && model?.fal_endpoint_id) {
      try {
        const credential = await getFalCredentialById(version.fal_credential_id, admin);
        await createFalClient({ credentials: credential.apiKey }).queue.cancel(model.fal_endpoint_id, { requestId: version.provider_request_id });
      } catch {
        // Cancellation may already have completed remotely; never log provider errors or credentials.
        console.warn('Annulation Fal non confirmée.');
      }
    }
    const { error: versionUpdateError } = await admin.from('video_versions').update({ status: 'cancelled', error_message: 'Annulée par l’utilisateur.', updated_at: now }).eq('id', id).in('status', ['queued', 'generating']);
    if (versionUpdateError) throw versionUpdateError;
    await admin.from('videos').update({ status: 'cancelled', updated_at: now }).eq('id', version.video_id);
    await admin.from('usage_ledger').update({ status: 'released' }).eq('version_id', id).eq('status', 'reserved');
    await admin.from('notifications').upsert({ user_id: video.user_id, version_id: id, type: 'cancelled', message: 'La génération a été annulée.' }, { onConflict: 'user_id,version_id,type', ignoreDuplicates: true });
    await pruneRetiredFalCredentials(admin);
    return NextResponse.json({ id, status: 'cancelled' });
  } catch (error) { return errorResponse(error); }
}
