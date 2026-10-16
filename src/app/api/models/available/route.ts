import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
import { calculateClientPriceFcfa } from '@/core/pricing';
import { getSupportedReferenceDurations } from '@/core/providers/storyboard-routing';
import { REFERENCE_MODEL_ENDPOINTS, type GenerationTier } from '@/core/providers/model-routing';

export async function GET() {
  try {
    await getActor();
    if (env.PROVIDERS_MODE === 'mock') return NextResponse.json({ models: [] });
    const admin = createStorageAdminClient();
    const { data, error } = await admin.from('ai_models')
      .select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default')
      .eq('is_active', true);
    if (error) throw new HttpError(503, 'Impossible de charger les modèles disponibles.');
    const referenceModels = (data ?? []).flatMap((model) => {
      if (model.tier !== 'standard' && model.tier !== 'pro' && model.tier !== 'premium') return [];
      const tier = model.tier as GenerationTier;
      const formats = (model.allowed_formats as string[]).filter((format) => ['16:9', '9:16', '1:1'].includes(format));
      const durations = getSupportedReferenceDurations(tier, model.allowed_durations as number[] | null);
      if (model.fal_endpoint_id !== REFERENCE_MODEL_ENDPOINTS[tier] || !formats.length || !durations.length) return [];
      const estimatedPricesFcfa = Object.fromEntries(durations.map((duration) => [duration, calculateClientPriceFcfa(duration * Number(model.price_usd_per_second), env.USD_TO_EUR_RATE, env.EUR_TO_FCFA)]));
      return [{ id: model.id, name: model.name, tier, adapterFamily: model.adapter_family, formats, durations, estimatedPricesFcfa, isDefault: model.is_default, isReference: true }];
    });
    return NextResponse.json({ models: referenceModels });
  } catch (error) { return errorResponse(error); }
}
