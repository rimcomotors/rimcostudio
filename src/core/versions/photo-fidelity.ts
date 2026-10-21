import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Actor } from '@/core/auth/guards';
import { HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { findCuratedLocation, locationCatalog } from '@/core/assets/location-catalog';
import { hasTransparentPngPixels } from '@/core/postproduction/photo-fidelity';
import { renderPhotoFidelityMontage } from '@/core/postproduction/pipeline';
import { validatePhotoFidelityPlan, type ClipDurationSeconds, type PhotoFidelityShot } from '@/core/storyboard';
import type { VideoFormat } from '@/core/postproduction/ffmpeg-args';

type CreatePhotoFidelityInput = {
  title: string;
  description: string;
  assetId: string;
  vehicleDossierId: string;
  vehicleDossierIds: string[];
  storyMode: 'standard' | 'pro' | 'premium';
  clipDurationSeconds: ClipDurationSeconds;
  format: VideoFormat;
  storyboard: PhotoFidelityShot[];
  placeIds: string[];
};

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export async function createLivePhotoFidelity(actor: Actor, input: CreatePhotoFidelityInput) {
  if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');
  validatePhotoFidelityPlan(input.storyboard, input.clipDurationSeconds);
  const dossierIds = [...new Set([input.vehicleDossierId, ...input.vehicleDossierIds])];
  const admin = createStorageAdminClient();
  const { data: dossiers, error: dossierError } = await admin.from('vehicle_dossiers')
    .select('id,make,model,color,variant,brand_id,assets(id,kind,path,title,angle,photo_role,status)')
    .in('id', dossierIds).eq('brand_id', actor.brandId);
  const dossier = dossiers?.find((entry) => entry.id === input.vehicleDossierId);
  if (dossierError || !dossiers || !dossier || dossiers.length !== dossierIds.length) throw new HttpError(422, 'Choisissez un dossier véhicule de votre marque.');
  const vehiclePhotos = dossiers.flatMap((entry) => entry.assets ?? []).filter((asset) => asset.kind === 'vehicle' && asset.status === 'validée');
  const locationIds = [...new Set([...input.placeIds, ...input.storyboard.map((shot) => shot.locationPhotoId).filter((id): id is string => typeof id === 'string' && id.length > 0)])];
  const curatedPlaces = locationIds.map(findCuratedLocation).filter((place) => place !== undefined);
  const curatedIds = new Set<string>(curatedPlaces.map((place) => place.id));
  const uploadedIds = locationIds.filter((id) => !curatedIds.has(id));
  const locationsQuery = uploadedIds.length ? await admin.from('assets').select('id,path,title,kind,status,brand_id').in('id', uploadedIds).eq('kind', 'place').eq('status', 'validée').eq('brand_id', actor.brandId) : { data: [], error: null };
  if (locationsQuery.error || (locationsQuery.data ?? []).length !== uploadedIds.length) throw new HttpError(422, 'Un lieu sélectionné n’est plus disponible.');
  const locations = [...curatedPlaces.map((place) => ({ id: place.id, path: place.path })), ...(locationsQuery.data ?? [])];
  const photosById = new Map(vehiclePhotos.map((photo) => [photo.id, photo]));
  const locationsById = new Map(locations.map((place) => [place.id, place]));
  if (input.storyboard.some((shot) => !photosById.has(shot.vehiclePhotoId))) throw new HttpError(422, 'Un plan utilise une photo de véhicule non validée dans votre sélection.');
  if (!input.storyboard.some((shot) => photosById.get(shot.vehiclePhotoId)?.photo_role !== 'interior')) throw new HttpError(422, 'Ajoutez au moins une vue extérieure détourée pour utiliser les lieux sélectionnés.');
  if (input.storyboard.some((shot) => {
    const photo = photosById.get(shot.vehiclePhotoId);
    return photo?.photo_role === 'interior'
      ? input.clipDurationSeconds === 5 || shot.locationPhotoId !== null && shot.locationPhotoId !== undefined
      : !shot.locationPhotoId || !locationsById.has(shot.locationPhotoId);
  })) throw new HttpError(422, 'Un plan extérieur doit utiliser un lieu réel et une photo PNG détourée; un plan intérieur plein cadre est disponible à partir de 10 secondes.');

  await Promise.all(input.storyboard.map(async (shot) => {
    const vehicle = photosById.get(shot.vehiclePhotoId)!;
    const vehicleBytes = await downloadAsset(admin, vehicle.path, 'La photo détourée du véhicule');
    if (vehicle.photo_role === 'interior') return;
    if (!hasTransparentPngPixels(vehicleBytes)) throw new HttpError(422, 'Pour le mode Fidélité photo, utilisez une vue extérieure du véhicule en PNG avec de vrais pixels transparents. Les appels IA ne seront pas utilisés.');
    await readLocation(admin, locationsById.get(shot.locationPhotoId!)!.path);
  }));

  const videoTitle = input.title || `${dossier.make ?? ''} ${dossier.model ?? 'Véhicule'} · Fidélité photo`.trim();
  const { data: video, error: videoError } = await admin.from('videos').insert({ user_id: actor.id, brand_id: actor.brandId, title: videoTitle, department: actor.department, status: 'generating' }).select('id').single();
  if (videoError || !video) throw new HttpError(500, 'Impossible de créer la vidéo. Réessayez.');
  const finalDurationSeconds = input.clipDurationSeconds + 2;
  const brief = {
    kind: 'photo_fidelity', photoFidelityMode: true, sourcePreserved: true,
    generationTier: input.storyMode, storyMode: input.storyMode,
    clipDurationSeconds: input.clipDurationSeconds, finalDurationSeconds,
    duration_s: input.clipDurationSeconds, generation_seconds: finalDurationSeconds,
    format: input.format, vehicleDossierId: input.vehicleDossierId,
    placeIds: input.placeIds, storyboard: input.storyboard,
    qualityCheck: { method: 'source-composition', targetSsim: 0.98, status: 'not_measured' },
  };
  const { data: version, error: versionError } = await admin.from('video_versions').insert({
    video_id: video.id, number: 1, brief_json: brief,
    generated_prompt: 'Montage déterministe à partir des photos validées. Aucun appel de modèle vidéo IA.',
    ai_model_id: null, provider_request_id: 'photo-fidelity', status: 'queued', generation_seconds: finalDurationSeconds,
  }).select('id').single();
  if (versionError || !version) {
    await admin.from('videos').delete().eq('id', video.id);
    throw new HttpError(500, 'Impossible de créer la version de la vidéo. Réessayez.');
  }
  return { id: version.id, status: 'queued' as const, totalShots: input.storyboard.length, estimatedPriceFcfa: 0, fidelityStatus: 'Références réelles conservées; score SSIM non mesuré.' };
}

export async function refreshLivePhotoFidelity(versionId: string, actor: Actor) {
  const admin = createStorageAdminClient();
  const { data: version, error } = await admin.from('video_versions')
    .select('id,video_id,status,final_path,updated_at,brief_json,video:videos!inner(id,user_id,brand_id,status)')
    .eq('id', versionId).single();
  if (error || !version) throw new HttpError(404, 'Cette version est introuvable.');
  const video = Array.isArray(version.video) ? version.video[0] : version.video;
  if (!video || video.user_id !== actor.id && actor.role !== 'admin') throw new HttpError(404, 'Cette version est introuvable.');
  if (version.status === 'ready' && version.final_path) return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, version.final_path) };
  if (version.status === 'failed') return { id: versionId, status: 'failed' as const, error: 'Le montage Fidélité photo a échoué.' };
  if (version.status === 'postprocessing' && actor.id !== 'cron-reconcile' && Date.now() - new Date(version.updated_at).getTime() < 60_000) return { id: versionId, status: 'postprocessing' as const };

  const brief = version.brief_json as Record<string, unknown>;
  const shots = brief.storyboard as PhotoFidelityShot[];
  const duration = brief.clipDurationSeconds as ClipDurationSeconds;
  const format = brief.format as VideoFormat;
  validatePhotoFidelityPlan(shots, duration);
  const { data: claimed, error: claimError } = await admin.from('video_versions')
    .update({ status: 'postprocessing', updated_at: new Date().toISOString() })
    .eq('id', versionId).eq('updated_at', version.updated_at).in('status', ['queued', 'postprocessing']).select('id').maybeSingle();
  if (claimError) throw new HttpError(503, 'Impossible de réclamer le montage Fidélité photo.');
  if (!claimed) return { id: versionId, status: 'postprocessing' as const };

  try {
    const vehicleIds = [...new Set(shots.map((shot) => shot.vehiclePhotoId))];
    const placeIds = [...new Set(shots.map((shot) => shot.locationPhotoId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
    const [{ data: vehiclePhotos, error: vehiclesError }, placeAssets] = await Promise.all([
      admin.from('assets').select('id,path,kind,status,brand_id,photo_role').in('id', vehicleIds).eq('kind', 'vehicle').eq('status', 'validée').eq('brand_id', video.brand_id),
      resolveLocations(admin, placeIds, video.brand_id),
    ]);
    if (vehiclesError || (vehiclePhotos ?? []).length !== vehicleIds.length || placeAssets.length !== placeIds.length) throw new HttpError(422, 'Une référence validée n’est plus accessible.');
    const vehiclesById = new Map((vehiclePhotos ?? []).map((photo) => [photo.id, photo]));
    const placesById = new Map(placeAssets.map((place) => [place.id, place]));
    const renderedShots = await Promise.all(shots.map(async (shot) => {
      const vehicle = vehiclesById.get(shot.vehiclePhotoId);
      if (!vehicle) throw new HttpError(422, 'Une photo de véhicule n’est plus disponible.');
      const vehicleBytes = await downloadAsset(admin, vehicle.path, 'La photo détourée du véhicule');
      if (vehicle.photo_role === 'interior') {
        if (duration === 5) throw new HttpError(422, 'Une vidéo de 5 secondes exige une vue extérieure et un lieu sélectionné.');
        return { background: vehicleBytes, durationSeconds: shot.durationSeconds };
      }
      const place = shot.locationPhotoId ? placesById.get(shot.locationPhotoId) : undefined;
      if (!place) throw new HttpError(422, 'Un lieu réel n’est plus disponible pour un plan extérieur.');
      if (!hasTransparentPngPixels(vehicleBytes)) throw new HttpError(422, 'La photo du véhicule ne contient pas de pixels transparents.');
      return { background: await readLocation(admin, place.path), vehicleCutout: vehicleBytes, durationSeconds: shot.durationSeconds };
    }));
    const output = await renderPhotoFidelityMontage({ shots: renderedShots, clipDurationSeconds: duration, format });
    if (output.length > MAX_VIDEO_BYTES) throw new HttpError(502, 'La vidéo finale dépasse la taille autorisée.');
    const finalPath = `${version.video_id}/${versionId}/photo-fidelity.mp4`;
    const { error: uploadError } = await admin.storage.from('videos').upload(finalPath, output, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new HttpError(502, 'Impossible d’enregistrer le montage dans le stockage sécurisé.');
    const { error: versionUpdateError } = await admin.from('video_versions').update({ status: 'ready', final_path: finalPath, error_message: null, updated_at: new Date().toISOString() }).eq('id', versionId);
    if (versionUpdateError) throw new HttpError(503, 'Le fichier est enregistré; son état doit être réconcilié.');
    const { error: videoUpdateError } = await admin.from('videos').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', version.video_id);
    if (videoUpdateError) throw new HttpError(503, 'Le montage est prêt; son état doit être réconcilié.');
    return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, finalPath), totalShots: shots.length, fidelityStatus: 'Photos sources conservées; SSIM non mesuré automatiquement.' };
  } catch (cause) {
    const message = cause instanceof HttpError ? cause.message : 'Le montage photo a échoué.';
    await Promise.all([
      admin.from('video_versions').update({ status: 'failed', error_message: message, updated_at: new Date().toISOString() }).eq('id', versionId),
      admin.from('videos').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', version.video_id),
    ]);
    return { id: versionId, status: 'failed' as const, error: message };
  }
}

async function resolveLocations(admin: ReturnType<typeof createStorageAdminClient>, ids: string[], brandId: string) {
  const curated = ids.map(findCuratedLocation).filter((entry) => entry !== undefined).map((entry) => ({ id: entry.id, path: entry.path }));
  const curatedIds = new Set<string>(curated.map((entry) => entry.id));
  const uploadedIds = ids.filter((id) => !curatedIds.has(id));
  const { data, error } = uploadedIds.length ? await admin.from('assets').select('id,path,kind,status,brand_id').in('id', uploadedIds).eq('kind', 'place').eq('status', 'validée').eq('brand_id', brandId) : { data: [], error: null };
  if (error) throw new HttpError(503, 'Impossible de relire les lieux sélectionnés.');
  return [...curated, ...(data ?? [])];
}

async function downloadAsset(admin: ReturnType<typeof createStorageAdminClient>, path: string, label: string) {
  const { data, error } = await admin.storage.from('assets').download(path);
  if (error || !data) throw new HttpError(422, `${label} est introuvable dans la médiathèque.`);
  if (data.size > MAX_IMAGE_BYTES) throw new HttpError(413, `${label} dépasse 25 Mo.`);
  return Buffer.from(await data.arrayBuffer());
}

async function readLocation(admin: ReturnType<typeof createStorageAdminClient>, path: string) {
  if (path.startsWith('/places/')) {
    const curated = findCuratedLocationByPath(path);
    if (!curated) throw new HttpError(422, 'La référence du lieu n’est pas dans la médiathèque autorisée.');
    const bytes = await readFile(join(process.cwd(), 'public', curated.path.slice(1)));
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'La photo du lieu dépasse 25 Mo.');
    return bytes;
  }
  return downloadAsset(admin, path, 'La photo du lieu');
}

function findCuratedLocationByPath(path: string) {
  return locationCatalog.find((entry) => entry.path === path);
}

async function signedUrl(admin: ReturnType<typeof createStorageAdminClient>, path: string) {
  const { data, error } = await admin.storage.from('videos').createSignedUrl(path, 3600);
  if (error || !data) throw new HttpError(503, 'Impossible de créer le lien temporaire du montage.');
  return data.signedUrl;
}
