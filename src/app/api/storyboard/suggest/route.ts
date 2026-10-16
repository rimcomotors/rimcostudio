import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
import { buildStoryboardInstruction, generatedVideoSeconds, storyboardSchema, validateStoryboard, type StoryboardShot } from '@/core/storyboard';
import { getStoryboardModeRoute } from '@/core/providers/storyboard-routing';
import { createFalLlmProvider } from '@/core/providers/fal-llm';
import { createFalClient } from '@fal-ai/client';
import { reserveLlmCost, settleUsageCost } from '@/core/billing/ledger';
import { findCuratedLocation } from '@/core/assets/location-catalog';
import { calculateClientPriceFcfa } from '@/core/pricing';

const requestSchema = z.object({
  vehicleDossierId: z.string().uuid(),
  placeIds: z.array(z.string().uuid()).max(12).default([]),
  mode: z.enum(['standard', 'pro', 'premium']),
  durationSeconds: z.union([z.literal(15), z.literal(20)]),
  purpose: z.enum(['presentation', 'advertising']),
  direction: z.string().trim().max(500).default(''),
}).strict();
const storyboardResponseSchema = z.object({ shots: storyboardSchema }).strict();

export async function POST(request: Request) {
  try {
    const actor = await getActor();
    if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');
    const input = requestSchema.parse(await request.json());
    const supabase = await createSupabaseServerClient();
    const { data: dossier, error: dossierError } = await supabase.from('vehicle_dossiers')
      .select('id,make,model,color,variant,brand_id,assets(id,title,angle,photo_role,path,status,kind)')
      .eq('id', input.vehicleDossierId).eq('brand_id', actor.brandId).single();
    if (dossierError || !dossier) throw new HttpError(404, 'Dossier véhicule introuvable.');
    const vehiclePhotos = (dossier.assets ?? []).filter((asset) => asset.kind === 'vehicle' && asset.status === 'validée');
    if (!vehiclePhotos.length) throw new HttpError(422, 'Ce dossier ne contient pas encore de photo validée.');

    let places: Array<{ id: string; title: string | null; category: string | null; path: string }> = [];
    if (input.placeIds.length) {
      const curated = input.placeIds.map(findCuratedLocation).filter((place) => place !== undefined);
      const curatedIds = new Set<string>(curated.map((place) => place.id));
      const uploadedIds = input.placeIds.filter((id) => !curatedIds.has(id));
      const { data, error } = uploadedIds.length ? await supabase.from('assets').select('id,title,category,path,kind,status,brand_id')
        .in('id', uploadedIds).eq('kind', 'place').eq('status', 'validée').eq('brand_id', actor.brandId) : { data: [], error: null };
      if (error || !data || data.length !== uploadedIds.length) throw new HttpError(422, 'Un ou plusieurs lieux ne sont pas disponibles pour votre marque.');
      places = [...curated.map((place) => ({ id: place.id, title: place.title, category: place.category, path: place.path })), ...data];
    }
    const route = getStoryboardModeRoute(input.mode);
    const selectedVehicle = vehiclePhotos.slice(0, route.maxReferenceImages);
    const selectedPlaces = places.slice(0, Math.max(0, route.maxReferenceImages - 1));
    const instruction = buildStoryboardInstruction({
      durationSeconds: input.durationSeconds, mode: input.mode,
      vehicle: [dossier.make, dossier.model, dossier.variant, dossier.color].filter(Boolean).join(' '),
      vehiclePhotos: selectedVehicle.map((photo) => ({ id: photo.id, role: photo.photo_role ?? 'exterior', title: photo.title ?? 'Photo véhicule', angle: photo.angle })),
      places: selectedPlaces.map((place) => ({ id: place.id, title: place.title ?? 'Lieu', category: place.category })),
      purpose: input.purpose, direction: input.direction,
    });

    let shots: StoryboardShot[];
    let storyboardLedgerId: string | null = null;
    let storyboardCostUsd = 0;
    let totalEstimatedPriceFcfa: number | null = null;
    if (env.PROVIDERS_MODE === 'mock') {
      const total = generatedVideoSeconds(input.durationSeconds);
      const durations = total === 13 ? [7, 6] : [9, 9];
      shots = storyboardSchema.parse(durations.map((durationSeconds, index) => ({
        title: index === 0 ? 'Révélation du véhicule' : 'Détail et signature',
        scene: index === 0 ? 'Plan d’ensemble cinématographique' : 'Plan rapproché sur le véhicule',
        location: selectedPlaces[index % Math.max(1, selectedPlaces.length)]?.title ?? 'Abidjan, Côte d’Ivoire',
        action: index === 0 ? 'Le véhicule avance doucement dans son environnement réel.' : 'La caméra révèle les lignes et finitions présentes sur les photos.',
        camera: index === 0 ? 'Travelling latéral lent et stable' : 'Mouvement rapproché fluide',
        durationSeconds,
        vehiclePhotoId: selectedVehicle[index % selectedVehicle.length].id,
        locationPhotoId: selectedPlaces[index % Math.max(1, selectedPlaces.length)]?.id ?? null,
      })));
      totalEstimatedPriceFcfa = 0;
    } else {
      if (!env.FAL_KEY || !env.LLM_MODEL) throw new HttpError(503, 'Le modèle de storyboard IA n’est pas configuré.');
      const admin = createStorageAdminClient();
      const { data: videoModel } = await admin.from('ai_models').select('price_usd_per_second').eq('fal_endpoint_id', route.endpoint).eq('is_active', true).maybeSingle();
      const { data: reservation, error: reservationError } = await reserveLlmCost(admin, {
        userId: actor.id, department: actor.department, maxCostUsd: 0.02,
        usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
      });
      if (reservationError || !reservation) throw new HttpError(503, 'Impossible de réserver le coût de préparation du storyboard.');
      storyboardLedgerId = reservation;
      try {
        const provider = createFalLlmProvider(async (prompt, system) => {
          const fal = createFalClient({ credentials: env.FAL_KEY! });
          return fal.subscribe('openrouter/router', { input: {
            prompt, system_prompt: system, model: env.LLM_MODEL!, temperature: 0.2, max_tokens: 2400,
          } as never });
        });
        const result = await provider.buildStoryboardWithCost(instruction, storyboardResponseSchema, 'You are an expert automotive commercial director. Return only JSON matching the requested schema. Use French for all creative text.');
        shots = result.fields.shots;
        storyboardCostUsd = result.costUsd ?? 0.02;
        if (videoModel) {
          const videoCostUsd = generatedVideoSeconds(input.durationSeconds) * Number(videoModel.price_usd_per_second);
          totalEstimatedPriceFcfa = calculateClientPriceFcfa(videoCostUsd + storyboardCostUsd, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);
        }
        const { error: settleError } = await settleUsageCost(admin, { entryId: reservation, outcome: 'charged', actualCostUsd: storyboardCostUsd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        if (settleError) throw new HttpError(503, 'Le coût du storyboard n’a pas pu être clôturé.');
      } catch (cause) {
        await settleUsageCost(admin, { entryId: reservation, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        throw cause;
      }
    }
    validateStoryboard(shots, input.durationSeconds, route.adapterFamily);
    const vehicleIds = new Set(selectedVehicle.map((photo) => photo.id));
    const placeIds = new Set(selectedPlaces.map((place) => place.id));
    if (shots.some((shot) => !vehicleIds.has(shot.vehiclePhotoId) || (shot.locationPhotoId && !placeIds.has(shot.locationPhotoId)))) {
      throw new HttpError(422, 'Le storyboard référence une image non autorisée. Régénérez la proposition.');
    }
    return NextResponse.json({ storyboard: shots, prompt: instruction, mode: input.mode, durationSeconds: input.durationSeconds, storyboardLedgerId, storyboardCostUsd, storyboardCostFcfa: Math.round(storyboardCostUsd * env.USD_TO_EUR_RATE * env.EUR_TO_FCFA * 1.3), totalEstimatedPriceFcfa });
  } catch (error) { return errorResponse(error); }
}
