import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
import { storyboardSchema, validateStoryboard } from '@/core/storyboard';
import { getStoryboardModeRoute } from '@/core/providers/storyboard-routing';
import { requestSchema } from '@/core/versions/request-schema';
import { createLiveStoryboard } from '@/core/versions/storyboard-live';
import { estimateStoryboardComparisonUsd, reserveStoryboardComparisonBudget, STORYBOARD_COMPARISON_BUDGET_USD } from '@/core/comparisons/storyboard-budget';

const compareSchema = requestSchema.extend({
  vehicleDossierId: z.string().uuid(),
  placeIds: z.array(z.string().uuid()).max(12).default([]),
  clipDurationSeconds: z.union([z.literal(15), z.literal(20)]),
  purpose: z.enum(['presentation', 'advertising']),
  storyboard: storyboardSchema,
  campaignId: z.string().uuid().optional(),
}).strict();
const comparisonModes = ['standard', 'pro'] as const;

export async function POST(request: Request) {
  try {
    const actor = await getActor();
    if (actor.role !== 'admin') throw new HttpError(403, 'Le comparatif Wan/Kling est réservé à l’administration pendant la phase de test.');
    const input = compareSchema.parse(await request.json());
    if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');
    if (input.audioAssetId) throw new HttpError(422, 'Le comparatif est sans audio pour le moment.');
    for (const mode of comparisonModes) validateStoryboard(input.storyboard, input.clipDurationSeconds, getStoryboardModeRoute(mode).adapterFamily);
    if (env.PROVIDERS_MODE !== 'live') throw new HttpError(503, 'Le comparatif nécessite un environnement Fal connecté.');

    const admin = createStorageAdminClient();
    const endpoints = comparisonModes.map((mode) => getStoryboardModeRoute(mode).endpoint);
    const { data: models, error: modelsError } = await admin.from('ai_models')
      .select('id,fal_endpoint_id,price_usd_per_second,pricing_verified_at,allowed_formats,is_active')
      .in('fal_endpoint_id', endpoints).eq('is_active', true);
    if (modelsError || !models || models.length !== 2) throw new HttpError(503, 'Les modèles Wan 2.7 et Kling O3 ne sont pas tous deux activés.');
    if (models.some((model) => !model.allowed_formats?.includes(input.format))) throw new HttpError(422, 'Les deux modèles du comparatif ne prennent pas en charge ce format.');
    if (models.some((model) => !model.pricing_verified_at || Date.now() - new Date(model.pricing_verified_at).getTime() > 7 * 24 * 60 * 60 * 1000)) {
      throw new HttpError(503, 'Les tarifs des modèles doivent être vérifiés et datés dans la configuration avant tout lancement.');
    }
    const clipSeconds = input.clipDurationSeconds;
    const estimatedRunUsd = estimateStoryboardComparisonUsd(models.map((model) => Number(model.price_usd_per_second)), clipSeconds);

    let campaignId = input.campaignId;
    let reservedUsd = 0;
    if (campaignId) {
      const { data: campaign, error } = await admin.from('comparisons').select('id,user_id,brief_json').eq('id', campaignId).single();
      const campaignBrief = campaign?.brief_json && typeof campaign.brief_json === 'object' ? campaign.brief_json as Record<string, unknown> : {};
      if (error || !campaign || campaign.user_id !== actor.id || campaignBrief.kind !== 'storyboard_multiclip_comparison') throw new HttpError(404, 'Campagne de comparatif introuvable.');
      if (campaignBrief.vehicleDossierId !== input.vehicleDossierId || campaignBrief.purpose !== input.purpose || campaignBrief.format !== input.format || JSON.stringify(campaignBrief.placeIds ?? []) !== JSON.stringify(input.placeIds)) throw new HttpError(422, 'Une campagne de comparatif conserve le même véhicule, les mêmes lieux, le même format et la même intention.');
      reservedUsd = Number(campaignBrief.reservedUsd ?? 0);
    } else {
      const { data: campaign, error } = await admin.from('comparisons').insert({
        user_id: actor.id,
        brief_json: { kind: 'storyboard_multiclip_comparison', vehicleDossierId: input.vehicleDossierId, placeIds: input.placeIds, purpose: input.purpose, format: input.format, createdAt: new Date().toISOString(), reservedUsd: 0, durations: [] },
      }).select('id').single();
      if (error || !campaign) throw new HttpError(503, 'Impossible de créer la campagne de comparatif.');
      campaignId = campaign.id;
    }
    const nextReservedUsd = reserveStoryboardComparisonBudget(reservedUsd, estimatedRunUsd);
    if (nextReservedUsd === null) throw new HttpError(422, `Le budget de comparatif de ${STORYBOARD_COMPARISON_BUDGET_USD} USD serait dépassé. Reste : ${(STORYBOARD_COMPARISON_BUDGET_USD - reservedUsd).toFixed(2)} USD.`);

    const { data: atomicReserved, error: reserveError } = await admin.rpc('reserve_storyboard_comparison_budget', {
      p_campaign_id: campaignId, p_amount_usd: estimatedRunUsd, p_max_usd: STORYBOARD_COMPARISON_BUDGET_USD,
    });
    if (reserveError || atomicReserved == null) throw new HttpError(422, `Le budget de comparatif de ${STORYBOARD_COMPARISON_BUDGET_USD} USD est épuisé ou n’a pas pu être réservé atomiquement.`);
    reservedUsd = Number(atomicReserved);

    const base = requestSchema.parse(input);
    const results = await Promise.allSettled(comparisonModes.map((storyMode) => createLiveStoryboard(actor, {
      ...base,
      storyboard: input.storyboard, storyMode, clipDurationSeconds: input.clipDurationSeconds,
      vehicleDossierId: input.vehicleDossierId, placeIds: input.placeIds, purpose: input.purpose,
      comparisonCampaignId: campaignId,
    })));
    const jobs = results.map((result, index) => result.status === 'fulfilled'
      ? { mode: comparisonModes[index], ...result.value }
      : { mode: comparisonModes[index], status: 'failed', error: result.reason instanceof Error ? result.reason.message : 'La génération a échoué.' });
    if (jobs.every((job) => job.status === 'failed')) throw new HttpError(503, 'Aucun des deux rendus n’a pu démarrer. Le budget est réservé pour éviter un dépassement; contactez un administrateur avant une nouvelle tentative.');
    return NextResponse.json({ campaignId, estimatedRunUsd, reservedUsd, jobs }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
