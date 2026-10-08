import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { env } from '@/env';
import { allVersions } from '@/core/versions/store';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { createSupabaseServerClient } from '@/core/supabase/server';
export async function GET() {
  try {
    const actor = await getActor();
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json({ rows: allVersions().filter((v) => actor.role === 'admin' || v.userId === actor.id).map((v) => ({ version_id: v.id, video_id: v.videoId, title: v.title ?? v.brief.vehicle_description, kind: 'generation', price_fcfa: v.priceFcfa, cost_real_fcfa: 0, cost_eur: 0, department: actor.department, model_name: 'Simulation', seconds: 5, status: v.status, created_at: v.createdAt })) });
    if (env.PROVIDERS_MODE === 'mock' && env.NEXT_PUBLIC_SUPABASE_URL) {
      const admin = createStorageAdminClient();
      let mockQuery = admin.from('videos').select('id,user_id,title,status,department,created_at,video_versions(id,number,status,brief_json,created_at,usage_ledger(kind,seconds,price_fcfa,status))').order('created_at', { ascending: false });
      if (actor.role === 'collaborateur') mockQuery = mockQuery.eq('user_id', actor.id);
      if (actor.role === 'valideur') {
        if (!actor.brandId) return NextResponse.json({ rows: [] });
        mockQuery = mockQuery.eq('brand_id', actor.brandId).eq('department', actor.department).eq('status', 'review');
      }
      const { data, error } = await mockQuery;
      if (error) throw new HttpError(503, 'Impossible de charger les coûts simulés.');
      const rows = (data ?? []).flatMap((video) => {
        const versions = Array.isArray(video.video_versions) ? video.video_versions : [];
        return versions.flatMap((version) => {
          const ledger = Array.isArray(version.usage_ledger) ? version.usage_ledger[0] : null;
          if (!ledger) return [];
          return [{ id: `${version.id}-generation`, version_id: version.id, video_id: video.id, title: video.title, kind: ledger.kind, price_fcfa: Number(ledger.price_fcfa), cost_real_fcfa: 0, cost_eur: 0, department: video.department, model_name: 'Simulation', seconds: Number(ledger.seconds), status: ledger.status, created_at: version.created_at }];
        });
      });
      return NextResponse.json({ rows });
    }
    const authenticated = await createSupabaseServerClient();
    let versionIds: string[] | null = null;
    if (actor.role === 'valideur') {
      if (!actor.brandId) return NextResponse.json({ rows: [] });
      const { data, error } = await authenticated.from('videos').select('id').eq('brand_id', actor.brandId).eq('department', actor.department).eq('status', 'review');
      if (error) throw new HttpError(503, 'Impossible de charger les vidéos en validation.');
      versionIds = (data ?? []).map((v) => v.id);
    }
    const admin = createStorageAdminClient();
    let query = admin.from('usage_ledger').select('id,version_id,user_id,kind,seconds,price_fcfa,status,created_at,video_versions(video_id,created_at,videos(title))').gt('price_fcfa', 0).order('created_at', { ascending: false });
    if (actor.role === 'collaborateur') query = query.eq('user_id', actor.id);
    if (versionIds) {
      if (!versionIds.length) return NextResponse.json({ rows: [] });
      const { data: versions, error } = await admin.from('video_versions').select('id').in('video_id', versionIds);
      if (error) throw new HttpError(503, 'Impossible de charger les coûts facturés.');
      const ids = (versions ?? []).map((v) => v.id);
      if (!ids.length) return NextResponse.json({ rows: [] });
      query = query.in('version_id', ids);
    }
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ rows: (data ?? []).map((row) => {
      const version = Array.isArray(row.video_versions) ? row.video_versions[0] : row.video_versions;
      const video = Array.isArray(version?.videos) ? version?.videos[0] : version?.videos;
      return { id: row.id, version_id: row.version_id, video_id: version?.video_id, title: video?.title ?? 'Vidéo', kind: row.kind, price_fcfa: Number(row.price_fcfa), seconds: Number(row.seconds), status: row.status, created_at: version?.created_at ?? row.created_at };
    }) });
  } catch (error) { return errorResponse(error); }
}
