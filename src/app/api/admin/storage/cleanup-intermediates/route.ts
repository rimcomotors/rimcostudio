import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireRole } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { collectCompletedIntermediatePaths } from '@/core/storage/intermediate-cleanup';

export const runtime = 'nodejs';
export const maxDuration = 60;

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview') }).strict(),
  z.object({ action: z.literal('cleanup'), versionIds: z.array(z.string().uuid()).min(1).max(10) }).strict(),
]);
const VERSION_SCAN_LIMIT = 2_000;

type StorageEntry = { name: string; metadata?: { size?: unknown } | null };

async function getReadyIntermediates(admin: ReturnType<typeof createStorageAdminClient>) {
  const { data: versions, error: versionError } = await admin.from('video_versions')
    .select('id,status,final_path,raw_path')
    .eq('status', 'ready')
    .not('final_path', 'is', null)
    .order('id', { ascending: true })
    .limit(VERSION_SCAN_LIMIT);
  if (versionError) throw new HttpError(503, 'Impossible de lire les vidéos terminées.');

  const versionIds = (versions ?? []).map((version) => version.id);
  if (!versionIds.length) return { versions: versions ?? [], shots: [] as Array<{ version_id: string; status: string; raw_path: string | null; video_quality_previous_path: string | null }>, paths: [] as ReturnType<typeof collectCompletedIntermediatePaths> };

  const { data: shots, error: shotError } = await admin.from('video_shots')
    .select('version_id,status,raw_path,video_quality_previous_path')
    .in('version_id', versionIds)
    .eq('status', 'ready');
  if (shotError) throw new HttpError(503, 'Impossible de lire les plans terminés.');
  return { versions: versions ?? [], shots: shots ?? [], paths: collectCompletedIntermediatePaths(versions ?? [], shots ?? []) };
}

async function estimateBytes(admin: ReturnType<typeof createStorageAdminClient>, paths: string[]) {
  const folders = new Map<string, Set<string>>();
  for (const path of paths) {
    const separator = path.lastIndexOf('/');
    const folder = separator < 0 ? '' : path.slice(0, separator);
    const name = separator < 0 ? path : path.slice(separator + 1);
    if (!name) continue;
    const names = folders.get(folder) ?? new Set<string>();
    names.add(name);
    folders.set(folder, names);
  }

  let bytes = 0;
  let unknownFiles = 0;
  for (const [folder, names] of folders) {
    const { data, error } = await admin.storage.from('videos').list(folder, { limit: 1000 });
    if (error) throw new HttpError(503, 'Impossible d’estimer le volume des clips intermédiaires.');
    const entries = (data ?? []) as StorageEntry[];
    for (const name of names) {
      const entry = entries.find((item) => item.name === name);
      const size = Number(entry?.metadata?.size);
      if (!entry || !Number.isFinite(size) || size < 0) unknownFiles += 1;
      else bytes += size;
    }
  }
  return { bytes, unknownFiles };
}

export async function POST(request: Request) {
  try {
    await requireRole('admin');
    let input: z.infer<typeof requestSchema>;
    try { input = requestSchema.parse(await request.json()); }
    catch { throw new HttpError(400, 'La demande de nettoyage est invalide.'); }

    const admin = createStorageAdminClient();
    const { versions, paths } = await getReadyIntermediates(admin);
    if (input.action === 'preview') {
      const versionIds = [...new Set(paths.map((item) => item.versionId))].slice(0, 10);
      const selectedPaths = paths.filter((item) => versionIds.includes(item.versionId));
      const size = await estimateBytes(admin, [...new Set(selectedPaths.map((item) => item.path))]);
      return NextResponse.json({
        versionIds,
        versions: versionIds.length,
        files: new Set(selectedPaths.map((item) => item.path)).size,
        estimatedBytes: size.bytes,
        unknownFiles: size.unknownFiles,
        hasMore: new Set(paths.map((item) => item.versionId)).size > versionIds.length,
      });
    }

    const versionIds = new Set(input.versionIds);
    const eligibleIds = new Set((versions ?? []).filter((version) => versionIds.has(version.id) && version.status === 'ready' && version.final_path).map((version) => version.id));
    const selectedPaths = paths.filter((item) => eligibleIds.has(item.versionId));
    if (!selectedPaths.length) return NextResponse.json({ deletedFiles: 0, estimatedBytes: 0 });

    const uniquePaths = [...new Set(selectedPaths.map((item) => item.path))];
    const size = await estimateBytes(admin, uniquePaths);
    const { error: removeError } = await admin.storage.from('videos').remove(uniquePaths);
    if (removeError) throw new HttpError(503, 'La suppression des clips intermédiaires a échoué. Les finales restent intactes.');

    const [versionUpdate, shotRawUpdate, previousRawUpdate] = await Promise.all([
      admin.from('video_versions').update({ raw_path: null }).in('id', [...eligibleIds]).eq('status', 'ready').in('raw_path', uniquePaths),
      admin.from('video_shots').update({ raw_path: null }).in('version_id', [...eligibleIds]).eq('status', 'ready').in('raw_path', uniquePaths),
      admin.from('video_shots').update({ video_quality_previous_path: null }).in('version_id', [...eligibleIds]).eq('status', 'ready').in('video_quality_previous_path', uniquePaths),
    ]);
    if (versionUpdate.error || shotRawUpdate.error || previousRawUpdate.error) throw new HttpError(503, 'Les clips ont été supprimés, mais leurs références doivent être réconciliées dans l’administration.');

    console.info('Clips intermédiaires Supabase nettoyés:', { versionCount: eligibleIds.size, fileCount: uniquePaths.length, bytes: size.bytes });
    return NextResponse.json({ deletedFiles: uniquePaths.length, estimatedBytes: size.bytes, unknownFiles: size.unknownFiles });
  } catch (error) {
    return errorResponse(error);
  }
}
