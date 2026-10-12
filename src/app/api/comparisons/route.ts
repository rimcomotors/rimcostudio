import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireRole } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
import { requestSchema } from '@/core/versions/request-schema';
import { createLiveVersion } from '@/core/versions/live';
import { listComparisons, saveComparison } from '@/core/comparisons/store';
export const maxDuration = 60;
const schema = z.object({
  brief: z.object({ description: z.string().trim().min(8).max(500), format: z.enum(['16:9','9:16','1:1','4:5']), location: z.string().max(160).default(''), setting: z.string().max(160).default(''), character: z.string().max(160).default(''), lighting: z.string().max(160).default('Lumière douce de fin de journée') }).strict(),
  assetId: z.string().min(1), modelIds: z.array(z.string().uuid()).min(2).max(3), notes: z.string().trim().max(2000).optional(),
}).superRefine((value, ctx) => { if (new Set(value.modelIds).size !== value.modelIds.length) ctx.addIssue({ code: 'custom', message: 'Chaque modèle doit être sélectionné une seule fois.', path: ['modelIds'] }); });
function comparisonStatus(results: Array<{ status: string }>, allModelsStarted: boolean) {
  if (results.length > 0 && results.every((result) => result.status === 'simulated')) return 'simulated';
  if (!allModelsStarted || results.some((result) => !['ready','failed'].includes(result.status))) return 'running';
  if (results.length > 0 && results.every((result) => result.status === 'failed')) return 'failed';
  return results.some((result) => result.status === 'failed') ? 'partial' : 'complete';
}
export async function GET() {
  try {
    await requireRole('admin');
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json({ comparisons: listComparisons() });
    const admin = createStorageAdminClient();
    const { data, error } = await admin.from('comparisons').select('id,user_id,brief_json,created_at').order('created_at', { ascending: false });
    if (error) throw error;
    const comparisons = data ?? [];
    const versionIds = comparisons.flatMap((comparison) => {
      const content = comparison.brief_json as { results?: Array<{ versionId?: string }> };
      return (content.results ?? []).flatMap((result) => result.versionId ? [result.versionId] : []);
    });
    const { data: versions } = versionIds.length
      ? await admin.from('video_versions').select('id,status,final_path,raw_path,created_at,updated_at,usage_ledger(cost_usd,cost_eur,cost_real_fcfa,price_fcfa,status,kind,ai_model_id)').in('id', versionIds)
      : { data: [] as Array<{ id: string; status: string; final_path: string | null; raw_path: string | null; created_at: string; updated_at: string; usage_ledger: Array<{ cost_usd: number; cost_eur: number; cost_real_fcfa: number; price_fcfa: number; status: string; kind: string; ai_model_id: string | null }> }> };
    const currentById = new Map((versions ?? []).map((version) => [version.id, version]));
    const enriched = await Promise.all(comparisons.map(async (comparison) => {
      const content = comparison.brief_json as { status?: string; results?: Array<{ versionId?: string; status: string }> };
      const results = await Promise.all((content.results ?? []).map(async (result) => {
        const version = result.versionId ? currentById.get(result.versionId) : undefined;
        const path = version?.final_path;
        let videoUrl: string | undefined;
        if (path) {
          const { data: signed } = await admin.storage.from('videos').createSignedUrl(path, 3600);
          videoUrl = signed?.signedUrl;
        }
        const ledgerRows = Array.isArray(version?.usage_ledger) ? version.usage_ledger : [];
        const generationLedger = ledgerRows.find((row) => row.kind === 'generation' && row.ai_model_id);
        const elapsedSeconds = version && ['ready', 'failed'].includes(version.status)
          ? Math.max(0, Math.round((new Date(version.updated_at).getTime() - new Date(version.created_at).getTime()) / 1000))
          : undefined;
        return {
          ...result,
          status: version?.status ?? result.status,
          ...(videoUrl ? { videoUrl } : {}),
          ...(generationLedger ? { costUsd: Number(generationLedger.cost_usd), costEur: Number(generationLedger.cost_eur), costRealFcfa: Number(generationLedger.cost_real_fcfa), priceFcfa: Number(generationLedger.price_fcfa), costStatus: generationLedger.status } : {}),
          ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
          ...(version ? { startedAt: version.created_at, finishedAt: ['ready', 'failed'].includes(version.status) ? version.updated_at : undefined } : {}),
        };
      }));
      const status = results.length === 0 ? content.status ?? 'draft' : comparisonStatus(results, true);
      return { ...comparison, brief_json: { ...content, status, results } };
    }));
    return NextResponse.json({ comparisons: enriched });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const actor = await requireRole('admin');
    const input = schema.parse(await request.json());
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      const names: Record<string, string> = {
        '00000000-0000-4000-8000-000000000002': 'Kling O3 Pro',
        '00000000-0000-4000-8000-000000000006': 'Seedance 2.5',
        '00000000-0000-4000-8000-000000000005': 'Veo 3.1 Fast',
        '00000000-0000-4000-8000-000000000004': 'Wan 3.0',
      };
      const comparison = saveComparison({ id: crypto.randomUUID(), user_id: actor.id, created_at: new Date().toISOString(), brief_json: {
        ...input,
        brief: input.brief,
        status: 'simulated',
        results: input.modelIds.map((modelId) => ({ modelId, modelName: names[modelId] ?? 'Modèle simulé', status: 'simulated', costUsd: 0, costEur: 0, costRealFcfa: 0, priceFcfa: 0 })),
      } });
      return NextResponse.json({ comparison }, { status: 201 });
    }
    const admin = createStorageAdminClient();
    const { data: models, error: modelError } = await admin.from('ai_models').select('id,name,tier,fal_endpoint_id,adapter_family,is_active,mode,allowed_durations,allowed_formats,price_usd_per_second').in('id', input.modelIds);
    const supported = (family: string, endpoint: string) => family === 'kling' && endpoint === 'fal-ai/kling-video/o3/pro/image-to-video' || family === 'seedance' && endpoint === 'bytedance/seedance-2.5/image-to-video' || family === 'wan' && endpoint === 'alibaba/wan-3.0/image-to-video' || family === 'veo' && endpoint === 'fal-ai/veo3.1/fast/image-to-video';
    const sourceDuration = (family: string) => family === 'veo' ? 6 : 5;
    if (modelError || !models || models.length !== input.modelIds.length || models.some((model) => !model.is_active || model.mode !== 'image_to_video' || !model.allowed_durations.includes(sourceDuration(model.adapter_family)) || !model.allowed_formats.includes(input.brief.format) || !supported(model.adapter_family, model.fal_endpoint_id))) throw new HttpError(422, 'Sélectionnez 2 ou 3 modèles vidéo actifs, vérifiés et compatibles avec le clip final de cinq secondes et le format choisi.');
    const { data: comparison, error } = await admin.from('comparisons').insert({ user_id: actor.id, brief_json: { ...input, status: env.PROVIDERS_MODE === 'live' ? 'running' : 'draft', results: [] } }).select('id,user_id,brief_json,created_at').single();
    if (error || !comparison) throw new HttpError(503, 'Impossible d’enregistrer cette comparaison.');
    if (env.PROVIDERS_MODE !== 'live') {
      const results = models.map((model) => ({ modelId: model.id, modelName: model.name, status: 'simulated', costUsd: 0, costEur: 0, costRealFcfa: 0, priceFcfa: 0 }));
      const briefJson = { ...input, status: 'simulated', results };
      const { data: updated, error: updateError } = await admin.from('comparisons').update({ brief_json: briefJson }).eq('id', comparison.id).select('id,user_id,brief_json,created_at').single();
      if (updateError || !updated) throw new HttpError(503, 'La comparaison simulée n’a pas pu être enregistrée.');
      return NextResponse.json({ comparison: updated }, { status: 201 });
    }

    const commonRequest = requestSchema.parse({ ...input.brief, assetId: input.assetId, tier: 'standard' });
    const results: Array<{ modelId: string; modelName: string; versionId?: string; status: string; error?: string }> = [];
    let shared: { brief: import('@/core/brief').Brief; prompt: string } | undefined;
    for (const model of models) {
      try {
        const tier = model.tier === 'test' ? 'test' : model.tier === 'standard' ? 'standard' : 'premium';
        const result = await createLiveVersion(actor, { ...commonRequest, tier }, { modelId: model.id, ...(shared ? { reuse: shared } : {}) });
        if ('brief' in result) shared ??= { brief: result.brief, prompt: result.prompt };
        results.push({ modelId: model.id, modelName: model.name, versionId: result.id, status: result.status });
      } catch (error) {
        results.push({ modelId: model.id, modelName: model.name, status: 'failed', error: error instanceof Error ? error.message : 'La génération de comparaison a échoué.' });
      }
      await admin.from('comparisons').update({ brief_json: { ...input, status: comparisonStatus(results, results.length === models.length), results } }).eq('id', comparison.id);
    }
    const status = comparisonStatus(results, true);
    const { data: updated } = await admin.from('comparisons').select('id,user_id,brief_json,created_at').eq('id', comparison.id).single();
    return NextResponse.json({ comparison: updated ?? { ...comparison, brief_json: { ...input, status, results } } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
