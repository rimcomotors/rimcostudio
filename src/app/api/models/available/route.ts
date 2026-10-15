import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
import { calculateClientPriceFcfa } from '@/core/pricing';
import { getRouteForGeneration, getRoutedDurations, isModelOnRoute, type GenerationTier } from '@/core/providers/model-routing';

export async function GET() {
  try {
    await getActor();
    if (env.PROVIDERS_MODE === 'mock') return NextResponse.json({ models: [] });
    const admin = createStorageAdminClient();
    const { data, error } = await admin.from('ai_models')
      .select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default')
      .eq('is_active', true);
    if (error) throw new HttpError(503, 'Impossible de charger les modèles disponibles.');
    const models = (data ?? []).flatMap((model) => {
      if (model.tier !== 'standard' && model.tier !== 'pro' && model.tier !== 'premium') return [];
      const tier = model.tier as GenerationTier;
      const durations = getRoutedDurations(tier).filter((duration) => isModelOnRoute({ tier: model.tier, adapterFamily: model.adapter_family, endpoint: model.fal_endpoint_id, allowedDurations: model.allowed_durations }, tier, duration));
      if (!durations.length) return [];
      const estimatedPricesFcfa = Object.fromEntries([
        ...durations.map((duration) => {
          const route = getRouteForGeneration(tier, duration);
          return [duration, calculateClientPriceFcfa((route?.sourceDuration ?? duration) * Number(model.price_usd_per_second), env.USD_TO_EUR_RATE, env.EUR_TO_FCFA)] as const;
        }),
      ]);
      return [{ id: model.id, name: model.name, tier: model.tier, adapterFamily: model.adapter_family, formats: model.allowed_formats, durations, estimatedPricesFcfa, isDefault: model.is_default }];
    });
    return NextResponse.json({ models });
  } catch (error) { return errorResponse(error); }
}
