import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { env } from '@/env';
import { allVersions } from '@/core/versions/store';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { aggregateGenerationCost } from '@/core/billing/aggregate';
export async function GET() {
  try {
    const actor = await getActor();
    if (actor.role !== 'admin') throw new HttpError(403, 'Le suivi de consommation est réservé à l’administration.');
    const role = actor.role as string;
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json({ rows: allVersions().filter((v) => actor.role === 'admin' || v.userId === actor.id).map((v) => ({ version_id: v.id, video_id: v.videoId, title: v.title ?? v.brief.vehicle_description, kind: 'generation', price_fcfa: v.priceFcfa, cost_real_fcfa: 0, cost_eur: 0, department: actor.department, model_name: 'Simulation', seconds: 5, status: v.status, created_at: v.createdAt })) });
    if (env.PROVIDERS_MODE === 'mock' && env.NEXT_PUBLIC_SUPABASE_URL) {
      const admin = createStorageAdminClient();
      let mockQuery = admin.from('videos').select('id,user_id,title,status,department,created_at,video_versions(id,number,status,brief_json,created_at,usage_ledger(kind,ai_model_id,seconds,cost_usd,billable_cost_usd,cost_eur,cost_real_fcfa,price_fcfa,status))').order('created_at', { ascending: false });
      if (role === 'collaborateur') mockQuery = mockQuery.eq('user_id', actor.id);
      if (role === 'valideur') {
        if (!actor.brandId) return NextResponse.json({ rows: [] });
        mockQuery = mockQuery.eq('brand_id', actor.brandId).eq('department', actor.department).eq('status', 'review');
      }
      const { data, error } = await mockQuery;
      if (error) throw new HttpError(503, 'Impossible de charger les coûts simulés.');
      const rows = (data ?? []).flatMap((video) => {
        const versions = Array.isArray(video.video_versions) ? video.video_versions : [];
        return versions.flatMap((version) => {
          const ledgerRows = Array.isArray(version.usage_ledger) ? version.usage_ledger : [];
          const generationCost = aggregateGenerationCost(ledgerRows, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);
          if (!generationCost) return [];
          return [{ id: `${version.id}-generation`, version_id: version.id, video_id: video.id, title: video.title, kind: 'generation', price_fcfa: generationCost.priceFcfa, cost_real_fcfa: 0, cost_eur: 0, department: video.department, model_name: 'Simulation', seconds: generationCost.seconds, status: generationCost.status, created_at: version.created_at }];
        });
      });
      return NextResponse.json({ rows });
    }
    const authenticated = await createSupabaseServerClient();
    let versionIds: string[] | null = null;
    if (role === 'valideur') {
      if (!actor.brandId) return NextResponse.json({ rows: [] });
      const { data, error } = await authenticated.from('videos').select('id').eq('brand_id', actor.brandId).eq('department', actor.department).eq('status', 'review');
      if (error) throw new HttpError(503, 'Impossible de charger les vidéos en validation.');
      versionIds = (data ?? []).map((v) => v.id);
    }
    const admin = createStorageAdminClient();
    let query = admin.from('usage_ledger').select('id,version_id,user_id,kind,ai_model_id,seconds,cost_usd,billable_cost_usd,cost_eur,cost_real_fcfa,price_fcfa,status,created_at,video_versions(video_id,created_at,videos(title))').in('kind', ['generation', 'keyframe']).order('created_at', { ascending: false });
    if (role === 'collaborateur') query = query.eq('user_id', actor.id);
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
    const grouped = new Map<string, NonNullable<typeof data>>();
    for (const row of data ?? []) {
      const rows = grouped.get(row.version_id) ?? [];
      rows.push(row);
      grouped.set(row.version_id, rows);
    }
    const rows = [...grouped.entries()].flatMap(([versionId, ledgerRows]) => {
      const generationCost = aggregateGenerationCost(ledgerRows.filter((row) => row.kind === 'generation'), env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);
      if (!generationCost) return [];
      const first = ledgerRows[0];
      const version = Array.isArray(first.video_versions) ? first.video_versions[0] : first.video_versions;
      const video = Array.isArray(version?.videos) ? version?.videos[0] : version?.videos;
      const chargedCosts = ledgerRows.filter((row) => row.status === 'charged');
      const costEur = chargedCosts.reduce((sum, row) => sum + Number(row.cost_eur ?? 0), 0);
      const costRealFcfa = chargedCosts.reduce((sum, row) => sum + Number(row.cost_real_fcfa ?? 0), 0);
      return [{ id: `${versionId}-generation`, version_id: versionId, video_id: version?.video_id, title: video?.title ?? 'Vidéo', kind: 'generation', price_fcfa: generationCost.priceFcfa, cost_real_fcfa: costRealFcfa, cost_eur: costEur, margin_fcfa: generationCost.priceFcfa - costRealFcfa, seconds: generationCost.seconds, status: generationCost.status, created_at: version?.created_at ?? first.created_at }];
    });
    return NextResponse.json({ rows });
  } catch (error) { return errorResponse(error); }
}
