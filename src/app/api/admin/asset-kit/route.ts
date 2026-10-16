import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorResponse, HttpError, requireRole } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { vehicleTestKit } from '@/core/assets/vehicle-kit';
import { env } from '@/env';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  try {
    const actor = await requireRole('admin');
    if (!actor.brandId) throw new HttpError(400, 'Aucune marque n’est associée à votre compte.');
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      throw new HttpError(503, 'L’import du kit nécessite une base Supabase connectée.');
    }

    const admin = createStorageAdminClient();
    let dossiersCreated = 0;
    let photosAdded = 0;
    let photosAlreadyPresent = 0;

    for (const vehicle of vehicleTestKit) {
      const { data: existingDossier, error: dossierLookupError } = await admin.from('vehicle_dossiers')
        .select('id')
        .eq('brand_id', actor.brandId)
        .eq('make', vehicle.make)
        .eq('model', vehicle.model)
        .eq('variant', vehicle.variant)
        .limit(1)
        .maybeSingle();
      if (dossierLookupError) throw new HttpError(503, 'Impossible de vérifier les dossiers du kit.');

      let dossierId = existingDossier?.id;
      if (!dossierId) {
        const { data: createdDossier, error: dossierInsertError } = await admin.from('vehicle_dossiers')
          .insert({ brand_id: actor.brandId, make: vehicle.make, model: vehicle.model, color: vehicle.color, variant: vehicle.variant, created_by: actor.id })
          .select('id')
          .single();
        if (dossierInsertError || !createdDossier) throw new HttpError(503, `Impossible de créer le dossier ${vehicle.make} ${vehicle.model}.`);
        dossierId = createdDossier.id;
        dossiersCreated += 1;
      }

      for (const photo of vehicle.photos) {
        const filePath = `/vehicle-kit/${vehicle.slug}/${photo.file}`;
        const storagePath = `${actor.id}/rimco-vehicle-kit/${vehicle.slug}/${photo.file}`;
        const bytes = await readFile(join(process.cwd(), 'public', filePath.slice(1)));
        const { error: uploadError } = await admin.storage.from('assets').upload(storagePath, bytes, {
          cacheControl: '31536000', contentType: 'image/webp', upsert: true,
        });
        if (uploadError) throw new HttpError(503, `Impossible de charger les références ${vehicle.make} ${vehicle.model}.`);

        const { data: existingPhoto, error: photoLookupError } = await admin.from('assets')
          .select('id')
          .eq('brand_id', actor.brandId)
          .eq('path', storagePath)
          .limit(1)
          .maybeSingle();
        if (photoLookupError) throw new HttpError(503, 'Impossible de vérifier les photos déjà importées.');

        const photoData = {
          vehicle_dossier_id: dossierId,
          photo_role: 'exterior',
          angle: photo.angle,
          title: photo.title,
          kind: 'vehicle',
          make: vehicle.make,
          model: vehicle.model,
          color: vehicle.color,
          variant: vehicle.variant,
          status: 'validée',
          brand_id: actor.brandId,
          created_by: actor.id,
          path: storagePath,
        };
        if (existingPhoto) {
          const { error: updateError } = await admin.from('assets').update(photoData).eq('id', existingPhoto.id);
          if (updateError) throw new HttpError(503, 'Impossible de rattacher une photo au bon dossier.');
          photosAlreadyPresent += 1;
        } else {
          const { error: photoInsertError } = await admin.from('assets').insert(photoData);
          if (photoInsertError) throw new HttpError(503, `Impossible d’enregistrer une photo de ${vehicle.make} ${vehicle.model}.`);
          photosAdded += 1;
        }
      }
    }

    return NextResponse.json({ dossiersCreated, photosAdded, photosAlreadyPresent, dossiersTotal: vehicleTestKit.length });
  } catch (error) {
    return errorResponse(error);
  }
}
