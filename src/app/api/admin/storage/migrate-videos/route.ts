import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireRole } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { serverVideoObjects } from '@/core/storage/server-video-objects';
import { env } from '@/env';

export const runtime = 'nodejs';
export const maxDuration = 60;

const requestSchema = z.object({ limit: z.number().int().min(1).max(2).default(2) }).strict();

export async function POST(request: Request) {
  try {
    await requireRole('admin');
    if (env.VIDEO_STORAGE_PROVIDER !== 'r2') throw new HttpError(409, 'Activez et configurez R2 avant de migrer les vidéos existantes.');
    let input: z.infer<typeof requestSchema>;
    try { input = requestSchema.parse(await request.json()); }
    catch { throw new HttpError(400, 'Le lot de migration demandé est invalide.'); }

    const admin = createStorageAdminClient();
    const { data: versions, error: queryError } = await admin.from('video_versions')
      .select('id,final_path')
      .eq('status', 'ready')
      .not('final_path', 'is', null)
      .not('final_path', 'like', 'r2://%')
      .order('id', { ascending: true })
      .limit(input.limit);
    if (queryError) throw new HttpError(503, 'Impossible de lister les vidéos existantes à migrer.');

    const objects = serverVideoObjects(admin);
    let migrated = 0;
    const failures: string[] = [];
    for (const version of versions ?? []) {
      if (!version.final_path) continue;
      try {
        const newPath = await objects.migrateLegacyFinal(version.final_path);
        const { data, error } = await admin.from('video_versions').update({ final_path: newPath })
          .eq('id', version.id).eq('final_path', version.final_path).select('id').maybeSingle();
        if (error) throw error;
        if (data) migrated += 1;
      } catch (error) {
        console.error('Migration de MP4 vers R2 échouée:', { versionId: version.id, error: error instanceof Error ? error.message : 'Erreur non détaillée.' });
        failures.push(version.id);
      }
    }

    return NextResponse.json({ migrated, failed: failures.length, failedVersionIds: failures, hasMore: (versions?.length ?? 0) === input.limit });
  } catch (error) {
    return errorResponse(error);
  }
}
