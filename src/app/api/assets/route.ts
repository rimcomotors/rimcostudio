import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getActor, errorResponse, HttpError } from '@/core/auth/guards';
import { env } from '@/env';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { createSignedStoragePreviewUrl } from '@/core/storage/signed-video';
import { assertPlaceUploadAdmin, assertVehicleDossierAdmin } from '@/core/assets/permissions';
import { curatedLocationAsset, locationCatalog } from '@/core/assets/location-catalog';

export async function GET(request: Request) {
  try {
    const actor = await getActor();
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      const fixtures = [
        { id: 'mock-haval-h6', kind: 'vehicle', make: 'Haval', model: 'H6', color: 'Bleu nuit', angle: 'Avant trois-quarts', variant: 'GT', previewUrl: '/mock/mock-video.svg', status: 'validée' },
        { id: 'mock-tank-300', kind: 'vehicle', make: 'GWM', model: 'Tank 300', color: 'Blanc', angle: 'Profil', variant: 'Urban', previewUrl: '/mock/mock-video.svg', status: 'validée' },
        { id: 'mock-kia-sportage', kind: 'vehicle', make: 'Kia', model: 'Sportage', color: 'Gris', angle: 'Avant', variant: 'EX', previewUrl: '/mock/mock-video.svg', status: 'validée' },
        { id: 'mock-abidjan-plateau', kind: 'place', title: 'Abidjan Plateau', previewUrl: '/mock/mock-video.svg', status: 'validée' },
        { id: 'mock-showroom', kind: 'decor', title: 'Showroom RIMCO', previewUrl: '/mock/mock-video.svg', status: 'validée' },
      ];
      const search = new URL(request.url).searchParams;
      const kind = search.get('kind');
      const status = search.get('status');
      const demoAssets = [...fixtures.filter((asset) => asset.kind !== 'place'), ...locationCatalog.map(curatedLocationAsset)];
      return NextResponse.json({ assets: demoAssets.filter((asset) => (!kind || asset.kind === kind) && (!status || asset.status === status)) });
    }
    const supabase = await createSupabaseServerClient();
    let query = supabase.from('assets').select('id,kind,title,category,make,model,color,angle,variant,path,status,review_reason').order('created_at', { ascending: false });
    const search = new URL(request.url).searchParams;
    const requestedKind = search.get('kind');
    const requestedStatus = search.get('status');
    if (requestedKind) query = query.eq('kind', requestedKind);
    if (requestedStatus) query = query.eq('status', requestedStatus);
    if (actor.role !== 'admin') {
      if (!actor.brandId) return NextResponse.json({ assets: [] });
      query = query.or(`and(brand_id.eq.${actor.brandId},status.eq.validée),created_by.eq.${actor.id}`);
    }
    const { data, error } = await query;
    if (error) throw error;
    const assets = await Promise.all((data ?? []).map(async (asset) => {
      const bucket = asset.kind === 'audio' ? 'audio' : asset.kind === 'logo' ? 'brand' : 'assets';
      const previewUrl = await createSignedStoragePreviewUrl((path, expiresIn) => supabase.storage.from(bucket).createSignedUrl(path, expiresIn), bucket, asset.path);
      return { ...asset, previewUrl };
    }));
    const curatedPlaces = locationCatalog.map(curatedLocationAsset).filter(() => (!requestedKind || requestedKind === 'place') && (!requestedStatus || requestedStatus === 'validée'));
    return NextResponse.json({ assets: [...curatedPlaces, ...assets] });
  } catch (error) { return errorResponse(error); }
}

const createSchema = z.object({ kind: z.enum(['vehicle','logo','audio','place','decor','wardrobe','badge']), path: z.string().trim().min(1).max(500), title: z.string().trim().max(160).optional(), category: z.string().trim().max(80).optional(), make: z.string().max(100).optional(), model: z.string().max(100).optional(), color: z.string().max(100).optional(), angle: z.string().max(100).optional(), variant: z.string().max(100).optional(), vehicleDossierId: z.string().uuid().optional(), photoRole: z.enum(['exterior','interior','detail']).optional() }).superRefine((value, context) => {
  if (value.vehicleDossierId && value.kind !== 'vehicle') context.addIssue({ code: 'custom', message: 'Un dossier ne peut contenir que des photos de véhicule.', path: ['kind'] });
  if (value.photoRole && !value.vehicleDossierId) context.addIssue({ code: 'custom', message: 'Le type de vue nécessite un dossier véhicule.', path: ['vehicleDossierId'] });
});
export async function POST(request: Request) {
  try {
    const actor = await getActor();
    const input = createSchema.parse(await request.json());
    if (input.kind === 'place') assertPlaceUploadAdmin(actor.role);
    if (input.vehicleDossierId) assertVehicleDossierAdmin(actor.role);
    if (!input.path.startsWith(`${actor.id}/`) && actor.id !== 'mock-admin') throw new HttpError(403, 'Le chemin de téléversement ne correspond pas à votre compte.');
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json({ asset: { id: crypto.randomUUID(), ...input, status: 'en_attente' } }, { status: 201 });
    const bucket = input.kind === 'audio' ? 'audio' : input.kind === 'logo' ? 'brand' : 'assets';
    const storageAdmin = createStorageAdminClient();
    const fileName = input.path.split('/').at(-1)!;
    const { data: objects, error: storageError } = await storageAdmin.storage.from(bucket).list(actor.id, { search: fileName, limit: 100 });
    if (storageError) throw new HttpError(400, 'Le fichier téléversé est introuvable. Téléversez-le à nouveau.');
    const object = objects?.find((entry) => entry.name === fileName);
    const metadata = object?.metadata as { size?: number; mimetype?: string } | undefined;
    const allowedMime = input.kind === 'audio' ? ['audio/mpeg','audio/wav','audio/mp4'] : ['image/jpeg','image/png','image/webp'];
    if (!metadata || !allowedMime.includes(metadata.mimetype ?? '') || Number(metadata.size ?? Infinity) > 25 * 1024 * 1024) throw new HttpError(422, 'Le type ou la taille du fichier téléversé ne sont pas acceptés.');
    const supabase = await createSupabaseServerClient();
    if (input.vehicleDossierId) {
      const { data: dossier, error: dossierError } = await supabase.from('vehicle_dossiers').select('id,brand_id').eq('id', input.vehicleDossierId).single();
      if (dossierError || !dossier || dossier.brand_id !== actor.brandId) throw new HttpError(404, 'Dossier véhicule introuvable.');
    }
    const { vehicleDossierId, photoRole, ...assetInput } = input;
    const { data, error } = await supabase.from('assets').insert({ ...assetInput, vehicle_dossier_id: vehicleDossierId ?? null, photo_role: photoRole ?? null, brand_id: actor.brandId, created_by: actor.id, status: 'en_attente' }).select('id,kind,title,category,make,model,color,angle,variant,path,status,review_reason,vehicle_dossier_id,photo_role').single();
    if (error) throw new HttpError(400, 'Impossible d’enregistrer ce média. Vérifiez son téléversement et réessayez.');
    return NextResponse.json({ asset: data }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
