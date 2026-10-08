import { NextResponse } from 'next/server';
import { requireRole, errorResponse, HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';

export async function GET() {
  try {
    await requireRole('admin');
    const admin = createStorageAdminClient();
    const { data, error } = await admin.from('usage_ledger')
      .select('version_id,kind,seconds,price_fcfa,status,created_at,video_versions(video_id,videos(title))')
      .gt('price_fcfa', 0)
      .order('created_at', { ascending: false });
    if (error) throw new HttpError(503, 'Impossible de charger les montants facturés.');
    const rows = (data ?? []).map((row) => {
      const version = Array.isArray(row.video_versions) ? row.video_versions[0] : row.video_versions;
      const video = Array.isArray(version?.videos) ? version.videos[0] : version?.videos;
      return { version_id: row.version_id, video_id: version?.video_id, title: video?.title ?? 'Vidéo', kind: row.kind, seconds: Number(row.seconds), price_fcfa: Number(row.price_fcfa), status: row.status, created_at: row.created_at };
    });
    return NextResponse.json({ rows });
  } catch (error) { return errorResponse(error); }
}
