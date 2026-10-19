import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireRole } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
const patchSchema = z.object({ id: z.string().uuid(), isActive: z.boolean().optional(), isDefault: z.boolean().optional() }).refine((v) => v.isActive !== undefined || v.isDefault !== undefined, { message: 'Aucune modification fournie.' });
export async function GET() {
  try {
    await requireRole('admin');
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json({ models: [
      { id: '00000000-0000-4000-8000-000000000002', tier: 'pro', comparisonCompatible: true, priceUsdPerSecond: 0.112, allowedDurations: [5,10,15], allowedFormats: ['16:9','9:16','1:1'], isActive: true, isDefault: true },
      { id: '00000000-0000-4000-8000-000000000006', tier: 'premium', comparisonCompatible: false, priceUsdPerSecond: 0.473, allowedDurations: [20], allowedFormats: ['16:9','9:16','1:1'], isActive: true, isDefault: true },
      { id: '00000000-0000-4000-8000-000000000005', tier: 'premium', comparisonCompatible: false, priceUsdPerSecond: 0.10, allowedDurations: [6], allowedFormats: ['16:9','9:16'], isActive: false, isDefault: false },
      { id: '00000000-0000-4000-8000-000000000004', tier: 'standard', comparisonCompatible: true, priceUsdPerSecond: 0.10, allowedDurations: [5], allowedFormats: ['16:9','9:16','1:1'], isActive: true, isDefault: false },
    ] });
    const admin = createStorageAdminClient();
    const { data, error } = await admin.from('ai_models').select('id,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default').order('tier').order('name');
    if (error) throw new HttpError(503, 'Impossible de charger le catalogue de modèles.');
    return NextResponse.json({ models: (data ?? []).map((model) => ({ id: model.id, tier: model.tier, comparisonCompatible: model.tier !== 'premium' && (model.adapter_family === 'kling' && model.fal_endpoint_id === 'fal-ai/kling-video/o3/pro/image-to-video' || model.adapter_family === 'wan' && model.fal_endpoint_id === 'alibaba/wan-3.0/image-to-video') && model.is_active, priceUsdPerSecond: Number(model.price_usd_per_second), allowedDurations: model.allowed_durations, allowedFormats: model.allowed_formats, isActive: model.is_active, isDefault: model.is_default })) });
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request) {
  try {
    await requireRole('admin');
    const input = patchSchema.parse(await request.json());
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json({ model: input });
    const admin = createStorageAdminClient();
    const { data: current, error: currentError } = await admin.from('ai_models').select('id,tier,fal_endpoint_id,adapter_family,allowed_durations,allowed_formats').eq('id', input.id).single();
    if (currentError || !current) throw new HttpError(404, 'Modèle introuvable.');
    const supportedEndpoint = (current.adapter_family === 'kling' && current.fal_endpoint_id === 'fal-ai/kling-video/o3/pro/image-to-video')
      || (current.adapter_family === 'seedance' && current.fal_endpoint_id === 'bytedance/seedance-2.5/image-to-video')
      || (current.adapter_family === 'wan' && current.fal_endpoint_id === 'alibaba/wan-3.0/image-to-video');
    const hasRequiredDuration = current.allowed_durations.includes(current.tier === 'premium' ? 20 : 5);
    if ((input.isActive || input.isDefault) && (!supportedEndpoint || !hasRequiredDuration || current.allowed_formats.length === 0)) throw new HttpError(422, 'Cet adaptateur ne prend pas en charge la chaîne live et la durée source configurées.');
    if (input.isDefault) {
      const { error: clearError } = await admin.from('ai_models').update({ is_default: false }).eq('tier', current.tier).neq('id', current.id);
      if (clearError) throw new HttpError(503, 'Impossible de modifier le modèle par défaut de cette catégorie.');
    }
    const patch = { ...(input.isActive !== undefined ? { is_active: input.isActive } : {}), ...(input.isDefault !== undefined ? { is_default: input.isDefault } : {}) };
    const { data, error } = await admin.from('ai_models').update(patch).eq('id', current.id).select('id,tier,is_active,is_default').single();
    if (error || !data) throw new HttpError(400, 'Impossible de modifier ce modèle.');
    return NextResponse.json({ model: { id: data.id, tier: data.tier, isActive: data.is_active, isDefault: data.is_default } });
  } catch (error) { return errorResponse(error); }
}
