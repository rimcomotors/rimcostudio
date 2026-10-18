import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, getActor, HttpError } from '@/core/auth/guards';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { env } from '@/env';
import { buildSingleShotStoryboardInstruction, buildStoryboardInstruction, getSingleShotClipDurations, singleShotStoryboardSchema, storyboardSchema, validateSingleShotStoryboard, validateStoryboard, type ClipDurationSeconds, type StoryboardShot } from '@/core/storyboard';
import { getStoryboardModeRoute } from '@/core/providers/storyboard-routing';
import { createFalLlmProvider, FalLlmBriefError } from '@/core/providers/fal-llm';
import { createFalClient } from '@fal-ai/client';
import { getActiveFalCredential } from '@/core/providers/fal-credential-vault';
import { reserveLlmCost, settleUsageCost } from '@/core/billing/ledger';
import { findCuratedLocation } from '@/core/assets/location-catalog';
import { calculateClientPriceFcfa } from '@/core/pricing';

const requestSchema = z.object({
  workflow: z.enum(['single', 'multi_clip']).default('multi_clip'),
  vehicleDossierId: z.string().uuid(),
  vehicleDossierIds: z.array(z.string().uuid()).max(20).default([]),
  placeIds: z.array(z.string().uuid()).max(12).default([]),
  mode: z.enum(['standard', 'pro', 'premium']),
  durationSeconds: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]),
  purpose: z.enum(['presentation', 'advertising']),
  direction: z.string().trim().max(500).default(''),
}).strict();
const storyboardResponseSchema = z.object({ shots: storyboardSchema }).strict();
const singleShotStoryboardResponseSchema = z.object({ shots: singleShotStoryboardSchema }).strict();

export async function POST(request: Request) {
  const referenceId = crypto.randomUUID();
  let falApiKeyForRedaction: string | null = null;
  try {
    const actor = await getActor();
    if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');
    const input = requestSchema.parse(await request.json());
    if (input.workflow === 'multi_clip' && input.durationSeconds !== 15 && input.durationSeconds !== 20) throw new HttpError(422, 'Le workflow multi-plans propose 15 ou 20 secondes de clips, puis ajoute 2 secondes de logo.');
    const supabase = await createSupabaseServerClient();
    const dossierIds = [...new Set([input.vehicleDossierId, ...input.vehicleDossierIds])];
    const { data: dossiers, error: dossierError } = await supabase.from('vehicle_dossiers')
      .select('id,make,model,color,variant,brand_id,assets(id,title,angle,photo_role,path,status,kind)')
      .in('id', dossierIds).eq('brand_id', actor.brandId);
    const dossier = dossiers?.find((entry) => entry.id === input.vehicleDossierId);
    if (dossierError || !dossier || !dossiers || dossiers.length !== dossierIds.length) throw new HttpError(404, 'Dossier véhicule introuvable.');
    const normalize = (value: string | null) => (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('fr');
    const identity = (entry: typeof dossier) => [entry.make, entry.model, entry.color, entry.variant].map(normalize).join('|');
    if (new Set(dossiers.map(identity)).size !== 1) throw new HttpError(422, 'Les dossiers regroupés doivent décrire exactement le même véhicule.');
    const vehiclePhotos = dossiers.flatMap((entry) => entry.assets ?? []).filter((asset) => asset.kind === 'vehicle' && asset.status === 'validée');
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
    const instructionInput = {
      durationSeconds: input.durationSeconds,
      vehicle: [dossier.make, dossier.model, dossier.variant, dossier.color].filter(Boolean).join(' '),
      vehiclePhotos: selectedVehicle.map((photo) => ({ id: photo.id, role: photo.photo_role ?? 'exterior', title: photo.title ?? 'Photo véhicule', angle: photo.angle })),
      places: selectedPlaces.map((place) => ({ id: place.id, title: place.title ?? 'Lieu', category: place.category })),
      purpose: input.purpose, direction: input.direction,
    };
    const instruction = input.workflow === 'single'
      ? buildSingleShotStoryboardInstruction(instructionInput)
      : buildStoryboardInstruction({ ...instructionInput, durationSeconds: input.durationSeconds as 15 | 20, mode: input.mode });

    let shots: StoryboardShot[];
    let storyboardLedgerId: string | null = null;
    let storyboardCostUsd = 0;
    let totalEstimatedPriceFcfa: number | null = null;
    if (env.PROVIDERS_MODE === 'mock') {
      const total = input.durationSeconds;
      const durations = input.workflow === 'single'
        ? [total]
        : total === 15 ? [8, 7] : [10, 10];
      const drafts = durations.map((durationSeconds, index) => ({
        title: index === 0 ? 'Révélation du véhicule' : 'Détail et signature',
        scene: index === 0 ? 'Plan d’ensemble cinématographique' : 'Plan rapproché sur le véhicule',
        location: selectedPlaces[index % Math.max(1, selectedPlaces.length)]?.title ?? 'Abidjan, Côte d’Ivoire',
        action: index === 0 ? 'Le véhicule avance doucement dans son environnement réel.' : 'La caméra révèle les lignes et finitions présentes sur les photos.',
        camera: index === 0 ? 'Travelling latéral lent et stable' : 'Mouvement rapproché fluide',
        durationSeconds,
        vehiclePhotoId: selectedVehicle[index % selectedVehicle.length].id,
        locationPhotoId: selectedPlaces[index % Math.max(1, selectedPlaces.length)]?.id ?? null,
      }));
      shots = input.workflow === 'single' ? singleShotStoryboardSchema.parse(drafts) : storyboardSchema.parse(drafts);
      totalEstimatedPriceFcfa = 0;
    } else {
      const admin = createStorageAdminClient();
      if (!env.LLM_MODEL) throw new HttpError(503, 'Le modèle de storyboard IA n’est pas configuré.');
      const falCredential = await getActiveFalCredential(admin);
      falApiKeyForRedaction = falCredential.apiKey;
      const { data: videoModel } = await admin.from('ai_models').select('price_usd_per_second').eq('fal_endpoint_id', route.endpoint).eq('is_active', true).maybeSingle();
      const { data: reservation, error: reservationError } = await reserveLlmCost(admin, {
        userId: actor.id, department: actor.department, maxCostUsd: 0.02,
        usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
      });
      if (reservationError || !reservation) throw new HttpError(503, 'Impossible de réserver le coût de préparation du storyboard.');
      storyboardLedgerId = reservation;
      try {
        const provider = createFalLlmProvider(async (prompt, system) => {
          const fal = createFalClient({ credentials: falCredential.apiKey });
          return fal.subscribe('openrouter/router', { input: {
            prompt, system_prompt: system, model: env.LLM_MODEL!, temperature: 0.2, max_tokens: 2400,
          } as never });
        });
        const responseSchema = input.workflow === 'single' ? singleShotStoryboardResponseSchema : storyboardResponseSchema;
        const result = await provider.buildStoryboardWithCost(instruction, responseSchema, 'You are an expert automotive commercial director. Return only JSON matching the requested schema. Use French for all creative text.');
        shots = result.fields.shots;
        storyboardCostUsd = result.costUsd ?? 0.02;
        if (videoModel) {
          const generationSeconds = input.workflow === 'single'
            ? getSingleShotClipDurations(input.durationSeconds as ClipDurationSeconds, route.adapterFamily).reduce((sum, seconds) => sum + seconds, 0)
            : input.durationSeconds;
          const videoCostUsd = generationSeconds * Number(videoModel.price_usd_per_second);
          totalEstimatedPriceFcfa = calculateClientPriceFcfa(videoCostUsd + storyboardCostUsd, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);
        }
        const { error: settleError } = await settleUsageCost(admin, { entryId: reservation, outcome: 'charged', actualCostUsd: storyboardCostUsd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        if (settleError) throw new HttpError(503, 'Le coût du storyboard n’a pas pu être clôturé.');
      } catch (cause) {
        const failedLlm = cause instanceof FalLlmBriefError ? cause : null;
        const actualFailureCostUsd = failedLlm
          ? failedLlm.reportedCostUsd ?? (failedLlm.completedRequests > 0 ? 0.02 : 0)
          : storyboardCostUsd;
        const { error: settlementError } = await settleUsageCost(admin, {
          entryId: reservation,
          outcome: actualFailureCostUsd > 0 ? 'charged' : 'released',
          actualCostUsd: actualFailureCostUsd,
          usdToEur: env.USD_TO_EUR_RATE,
          eurToFcfa: env.EUR_TO_FCFA,
          billable: false,
        });
        if (settlementError) console.error(`[storyboard-suggest:${referenceId}] Échec de clôture de la réservation LLM.`);
        throw cause;
      }
    }
    if (input.workflow === 'single') validateSingleShotStoryboard(shots, input.durationSeconds as ClipDurationSeconds, route.adapterFamily);
    else validateStoryboard(shots, input.durationSeconds as 15 | 20, route.adapterFamily);
    const vehicleIds = new Set(selectedVehicle.map((photo) => photo.id));
    const placeIds = new Set(selectedPlaces.map((place) => place.id));
    if (shots.some((shot) => !vehicleIds.has(shot.vehiclePhotoId) || (shot.locationPhotoId && !placeIds.has(shot.locationPhotoId)))) {
      throw new HttpError(422, 'Le storyboard référence une image non autorisée. Régénérez la proposition.');
    }
    return NextResponse.json({ storyboard: shots, prompt: instruction, mode: input.mode, durationSeconds: input.durationSeconds, finalVideoSeconds: input.durationSeconds + 2, storyboardLedgerId, storyboardCostUsd, storyboardCostFcfa: Math.round(storyboardCostUsd * env.USD_TO_EUR_RATE * env.EUR_TO_FCFA * 1.3), totalEstimatedPriceFcfa });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    if (error instanceof z.ZodError) return NextResponse.json({ error: 'Certains choix ont changé. Vérifiez les options du Studio puis réessayez.' }, { status: 422 });
    const providerCause = error instanceof FalLlmBriefError ? error.providerCause : undefined;
    const detail = (cause: unknown) => {
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? 'Erreur inconnue');
      return [falApiKeyForRedaction, env.FAL_KEY].filter((secret): secret is string => Boolean(secret)).reduce((safe, secret) => safe.replaceAll(secret, '[masqué]'), message);
    };
    console.error(`[storyboard-suggest:${referenceId}]`, {
      error: detail(error),
      ...(providerCause ? { provider: detail(providerCause) } : {}),
    });
    return NextResponse.json({
      error: 'Le service IA n’a pas pu préparer le storyboard. Aucune vidéo n’a été lancée. Réessayez; si le problème persiste, communiquez cette référence au support.',
      referenceId,
    }, { status: 502 });
  }
}
