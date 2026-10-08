import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
import { KLING_ENDPOINT } from '@/core/providers/fal-kling';
import { VEO_ENDPOINT } from '@/core/providers/fal-veo';
import { SEEDANCE_ENDPOINT } from '@/core/providers/fal-seedance';
import { WAN_ENDPOINT } from '@/core/providers/fal-wan';
import { calculateClientPriceFcfa } from '@/core/pricing';

export async function GET() {
  try {
    const actor = await getActor();
    if (env.PROVIDERS_MODE === 'mock') return NextResponse.json({ models: [] });
    const admin = createStorageAdminClient();
    const { data, error } = await admin.from('ai_models')
      .select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default')
      .eq('is_active', true);
    if (error) throw new HttpError(503, 'Impossible de charger les modèles disponibles.');
    const models = (data ?? []).flatMap((model) => {
      const supported = model.adapter_family === 'kling' && model.fal_endpoint_id === KLING_ENDPOINT && model.allowed_durations.includes(5)
        || model.adapter_family === 'seedance' && model.fal_endpoint_id === SEEDANCE_ENDPOINT && model.allowed_durations.includes(5)
        || model.adapter_family === 'veo' && model.fal_endpoint_id === VEO_ENDPOINT && (model.allowed_durations.includes(5) || model.allowed_durations.includes(6))
        || actor.role === 'admin' && model.adapter_family === 'wan' && model.fal_endpoint_id === WAN_ENDPOINT && model.allowed_durations.includes(5);
      if (!supported) return [];
      if (model.adapter_family === 'wan' && actor.role !== 'admin') return [];
      const durationChoices = model.adapter_family === 'veo' ? [5] : model.adapter_family === 'kling' ? [5, 10, 15] : model.adapter_family === 'seedance' ? [5, 10, 15, 20, 30] : [5];
      const durations = model.adapter_family === 'veo'
        ? durationChoices.filter((duration) => model.allowed_durations.includes(5) || model.allowed_durations.includes(6))
        : durationChoices.filter((duration) => model.allowed_durations.includes(duration));
      if (!durations.length) return [];
      const sourceDuration = model.adapter_family === 'veo' ? 6 : null;
      const estimatedPricesFcfa = Object.fromEntries(durations.map((duration) => [duration, calculateClientPriceFcfa((sourceDuration ?? duration) * Number(model.price_usd_per_second), env.USD_TO_EUR_RATE, env.EUR_TO_FCFA)]));
      return [{ id: model.id, name: model.name, tier: model.tier, adapterFamily: model.adapter_family, formats: model.allowed_formats, durations, estimatedPricesFcfa, isDefault: model.is_default }];
    });
    return NextResponse.json({ models });
  } catch (error) { return errorResponse(error); }
}
