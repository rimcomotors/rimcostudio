import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, getActor, HttpError, requireRole } from '@/core/auth/guards';
import { env } from '@/env';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { createStorageAdminClient } from '@/core/storage/supabase';

const createSchema = z.object({
  make: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  color: z.string().trim().max(100).optional(),
  variant: z.string().trim().max(100).optional(),
});

export async function GET() {
  try {
    const actor = await getActor();
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      return NextResponse.json({ vehicles: [{ id: 'mock-vehicle-dossier-h6', make: 'Haval', model: 'H6', color: 'Bleu nuit', variant: 'GT', photos: [{ id: 'mock-haval-h6', photoRole: 'exterior', title: 'Avant trois-quarts', previewUrl: '/mock/mock-video.svg' }] }] });
    }
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.from('vehicle_dossiers')
      .select('id,make,model,color,variant,brand_id,created_at,assets(id,kind,photo_role,title,angle,path,status)')
      .eq('brand_id', actor.brandId ?? '00000000-0000-0000-0000-000000000000')
      .order('created_at', { ascending: false });
    if (error) throw new HttpError(503, 'Impossible de charger les dossiers véhicules.');

    const storage = createStorageAdminClient();
    const vehicles = await Promise.all((data ?? []).map(async (dossier) => {
      const approvedPhotos = (dossier.assets ?? []).filter((asset) => asset.kind === 'vehicle' && asset.status === 'validée');
      const photos = await Promise.all(approvedPhotos.map(async (asset) => {
        const { data: signed } = await storage.storage.from('assets').createSignedUrl(asset.path, 3600);
        return { id: asset.id, photoRole: asset.photo_role, title: asset.title, angle: asset.angle, previewUrl: signed?.signedUrl ?? null };
      }));
      return { id: dossier.id, make: dossier.make, model: dossier.model, color: dossier.color, variant: dossier.variant, photos };
    }));
    return NextResponse.json({ vehicles });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireRole('admin');
    const input = createSchema.parse(await request.json());
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      return NextResponse.json({ vehicle: { id: crypto.randomUUID(), ...input, photos: [] } }, { status: 201 });
    }
    if (!actor.brandId) throw new HttpError(400, 'Aucune marque n’est associée à votre compte.');
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.from('vehicle_dossiers')
      .insert({ ...input, brand_id: actor.brandId, created_by: actor.id })
      .select('id,make,model,color,variant')
      .single();
    if (error || !data) throw new HttpError(400, 'Impossible de créer ce dossier véhicule.');
    return NextResponse.json({ vehicle: { ...data, photos: [] } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
