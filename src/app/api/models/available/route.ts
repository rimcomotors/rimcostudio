import { NextResponse } from 'next/server';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
import { KLING_ENDPOINT } from '@/core/providers/fal-kling';
import { VEO_ENDPOINT } from '@/core/providers/fal-veo';
import { SEEDANCE_ENDPOINT } from '@/core/providers/fal-seedance';
import { WAN_ENDPOINT } from '@/core/providers/fal-wan';

export async function GET() {
  try {
    const actor = await getActor();
    if (env.PROVIDERS_MODE === 'mock') return NextResponse.json({ models: [] });
    const admin = createStorageAdminClient();
    const { data, error } = await admin.from('ai_models')
      .select('id,name,tier,fal_endpoint_id,adapter_family,allowed_durations,allowed_formats,is_active,is_default')
      .eq('is_active', true);
    if (error) throw new HttpError(503, 'Impossible de charger les modèles disponibles.');
    const models = (data ?? []).flatMap((model) => {
      const supported = model.adapter_family === 'kling' && model.fal_endpoint_id === KLING_ENDPOINT && model.allowed_durations.includes(5)
        || model.adapter_family === 'seedance' && model.fal_endpoint_id === SEEDANCE_ENDPOINT && model.allowed_durations.includes(5)
        || model.adapter_family === 'veo' && model.fal_endpoint_id === VEO_ENDPOINT && model.allowed_durations.includes(6)
        || actor.role === 'admin' && model.adapter_family === 'wan' && model.fal_endpoint_id === WAN_ENDPOINT && model.allowed_durations.includes(5);
      if (!supported) return [];
      if (model.adapter_family === 'wan' && actor.role !== 'admin') return [];
      return [{ id: model.id, name: model.name, tier: model.tier, formats: model.allowed_formats, isDefault: model.is_default }];
    });
    return NextResponse.json({ models });
  } catch (error) { return errorResponse(error); }
}
