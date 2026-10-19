import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
import { estimateGridPriceFcfa } from '@/core/pricing';
import { getSupportedReferenceDurations } from '@/core/providers/storyboard-routing';
import { REFERENCE_MODEL_ENDPOINTS, type GenerationTier } from '@/core/providers/model-routing';

export async function GET() {
  try {
    const actor = await getActor();
    if (env.PROVIDERS_MODE === 'mock') return NextResponse.json({ models: [] });
    if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');
    const admin = createStorageAdminClient();
    const [{ data, error }, { data: pricing, error: pricingError }] = await Promise.all([admin.from('ai_models')
      .select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default')
      .eq('is_active', true), admin.from('pricing_settings').select('grid_fcfa_per_second_standard,grid_fcfa_per_second_premium').eq('brand_id', actor.brandId).maybeSingle()]);
    if (error) throw new HttpError(503, 'Impossible de charger les modèles disponibles.');
    if (pricingError || !pricing) throw new HttpError(503, 'La grille tarifaire de votre marque n’est pas configurée.');
    const referenceModels = (data ?? []).flatMap((model) => {
      if (model.tier !== 'standard' && model.tier !== 'pro' && model.tier !== 'premium') return [];
      const tier = model.tier as GenerationTier;
      const formats = (model.allowed_formats as string[]).filter((format) => ['16:9', '9:16', '1:1'].includes(format));
      const providerDurations = getSupportedReferenceDurations(tier, model.allowed_durations as number[] | null);
      const durations = tier === 'premium' ? providerDurations.filter((duration) => duration === 20) : providerDurations;
      if (model.fal_endpoint_id !== REFERENCE_MODEL_ENDPOINTS[tier] || !formats.length || !durations.length) return [];
      const estimatedPricesFcfa = Object.fromEntries(durations.map((duration) => [duration, estimateGridPriceFcfa(duration, tier, { standard: Number(pricing.grid_fcfa_per_second_standard), premium: Number(pricing.grid_fcfa_per_second_premium) })]));
      return [{ id: model.id, tier, formats, durations, estimatedPricesFcfa, isDefault: model.is_default }];
    });
    return NextResponse.json({ models: referenceModels });
  } catch (error) { return errorResponse(error); }
}
