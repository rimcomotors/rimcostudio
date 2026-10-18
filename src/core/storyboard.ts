import { z } from 'zod';
import type { Brief } from '@/core/brief';

export const storyModeSchema = z.enum(['standard', 'pro', 'premium']);
export type StoryMode = z.infer<typeof storyModeSchema>;
export type StoryProvider = 'wan' | 'kling' | 'seedance';
export type ClipDurationSeconds = 5 | 10 | 15 | 20;

export const shotDraftSchema = z.object({
  title: z.string().trim().min(1).max(80),
  scene: z.string().trim().min(1).max(160),
  framing: z.string().trim().min(1).max(120).default('Plan moyen'),
  location: z.string().trim().min(1).max(160),
  action: z.string().trim().min(1).max(180),
  camera: z.string().trim().min(1).max(160),
  durationSeconds: z.number().int().min(2).max(30),
  vehiclePhotoId: z.string().trim().min(1).max(100),
  locationPhotoId: z.string().trim().min(1).max(100).nullable().optional(),
}).strict();

export const storyboardSchema = z.array(shotDraftSchema).min(2).max(6);
export const singleShotStoryboardSchema = z.array(shotDraftSchema).length(1);
export type StoryboardShot = z.infer<typeof shotDraftSchema>;

export const photoFidelityShotSchema = z.object({
  title: z.string().trim().min(1).max(80),
  durationSeconds: z.number().int().min(1).max(20),
  vehiclePhotoId: z.string().trim().min(1).max(100),
  locationPhotoId: z.string().trim().min(1).max(100).nullable().optional(),
}).strict();
export type PhotoFidelityShot = z.infer<typeof photoFidelityShotSchema>;

export function validatePhotoFidelityPlan(shots: PhotoFidelityShot[], durationSeconds: ClipDurationSeconds): true {
  const parsed = z.array(photoFidelityShotSchema).min(1).max(6).parse(shots);
  if (durationSeconds === 5 && parsed.length !== 1) throw new Error('Une vidéo de 5 secondes utilise un seul plan.');
  if (durationSeconds === 5 && !parsed[0].locationPhotoId) throw new Error('Un plan de 5 secondes doit utiliser un lieu réel sélectionné.');
  if (parsed.reduce((sum, shot) => sum + shot.durationSeconds, 0) !== durationSeconds) throw new Error(`La durée des plans doit être exactement de ${durationSeconds} secondes avant le logo.`);
  return true;
}

export const STORYBOARD_LOGO_SECONDS = 2;
const providerLimits: Record<StoryProvider, { min: number; max: number }> = {
  wan: { min: 2, max: 10 },
  kling: { min: 3, max: 15 },
  seedance: { min: 4, max: 30 },
};

export function finalVideoSeconds(clipDurationSeconds: ClipDurationSeconds): number {
  return clipDurationSeconds + STORYBOARD_LOGO_SECONDS;
}

/** Split one approved creative direction into provider-safe clips when required. */
export function getSingleShotClipDurations(clipDurationSeconds: ClipDurationSeconds, provider: StoryProvider): number[] {
  const target = clipDurationSeconds;
  const { min, max } = providerLimits[provider];
  const total = Math.max(target, min);
  const count = Math.ceil(total / max);
  const base = Math.floor(total / count);
  const remainder = total % count;
  const durations = Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
  if (durations.some((duration) => duration < min || duration > max)) throw new Error('Impossible de répartir cette durée pour le modèle sélectionné.');
  return durations;
}

export function expandSingleShotStoryboard(shot: StoryboardShot, clipDurationSeconds: ClipDurationSeconds, provider: StoryProvider): StoryboardShot[] {
  const durations = getSingleShotClipDurations(clipDurationSeconds, provider);
  return durations.map((durationSeconds, index) => ({
    ...shot,
    title: durations.length === 1 ? shot.title : `${shot.title} · partie ${index + 1}`,
    action: durations.length === 1 ? shot.action : `${shot.action} Continuer le même mouvement de caméra et conserver exactement le même véhicule, lieu, lumière et axe visuel; le raccord doit être fluide.`,
    durationSeconds,
  }));
}

export function validateSingleShotStoryboard(shots: StoryboardShot[], clipDurationSeconds: ClipDurationSeconds, provider: StoryProvider): true {
  const [shot] = singleShotStoryboardSchema.parse(shots);
  if (shot.durationSeconds !== clipDurationSeconds) throw new Error(`Le plan doit durer exactement ${clipDurationSeconds} secondes avant l’écran final.`);
  getSingleShotClipDurations(clipDurationSeconds, provider);
  return true;
}

export function validateStoryboard(shots: StoryboardShot[], clipDurationSeconds: 5 | 10 | 15 | 20, provider: StoryProvider): true {
  const parsed = storyboardSchema.parse(shots);
  const expected = clipDurationSeconds;
  const total = parsed.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  if (total !== expected) throw new Error(`La durée des plans doit être exactement de ${expected} secondes avant le logo.`);
  const limits = providerLimits[provider];
  if (parsed.some((shot) => shot.durationSeconds < limits.min || shot.durationSeconds > limits.max)) {
    throw new Error(`Chaque plan doit durer entre ${limits.min} et ${limits.max} secondes maximum pour ce modèle.`);
  }
  return true;
}

export function shotToPrompt(
  brief: Brief,
  shot: StoryboardShot,
  index: number,
  shotCount: number,
  referenceMarker: '@' | '[' = '@',
  vehicleView?: { role?: string | null; angle?: string | null },
): string {
  const character = brief.character === 'Aucun personnage' ? 'none; do not add people' : brief.character || 'none; do not add people';
  const marker = (index: number) => referenceMarker === '@' ? `@Image${index}` : `[Image${index}]`;
  const view = [vehicleView?.role, vehicleView?.angle].filter((value) => typeof value === 'string' && value.trim()).join(', ');
  const vehicleReference = `Use ${marker(1)} (approved vehicle photo ${shot.vehiclePhotoId}${view ? `, showing ${view}` : ''}) as the authoritative vehicle identity and visible-view reference`;
  const locationReference = shot.locationPhotoId ? `Use ${marker(2)} (approved Côte d’Ivoire location photo ${shot.locationPhotoId}) as the only background and actual visual setting; preserve its recognizable landmarks and layout. Use the vehicle photo only for vehicle identity and visible geometry; ignore its original background.` : `Use the selected real Côte d’Ivoire location: ${shot.location}. Use the vehicle photo only for vehicle identity and visible geometry; do not copy its original background.`;
  return `Create one ${shot.durationSeconds}-second ${brief.format} image-to-video automotive shot, shot ${index + 1} of ${shotCount}. Create a premium, photorealistic automotive commercial in real-world live-action style. Use the attached approved assets as the only visual sources. VEHICLE: ${brief.vehicle_description}. ${vehicleReference}; preserve its exact silhouette, front and rear details, paint color, wheels, badges, proportions, and visible equipment across every shot. Show only surfaces and angles supported by the selected photo; never invent an unseen side, interior, trim, or feature. LOCATION: ${shot.location}. ${locationReference} Preserve the supplied place's real geometry, recognizable landmarks, architecture, road layout, and natural light; do not add buildings or signs. SHOT ${index + 1}/${shotCount}: Scene: ${shot.scene}. Framing: ${shot.framing}. Action: ${shot.action}. Camera: ${shot.camera}. Speed: normal live-action speed; no speed ramps. Effects: only natural environmental effects requested by the brief, such as dust from a dirt road; no synthetic visual effects. Edit transition: a clean cut between clips; do not synthesize a transition. Lighting: ${brief.lighting}. Mood: ${brief.mood}. Creative direction: premium, elegant, restrained automotive advertising; keep the vehicle the clear hero. Additional user direction: ${brief.user_direction || 'none; do not contradict the approved vehicle and location references'}. Character: ${character}. REALISM: Physically credible wheel rotation and suspension, stable geometry, natural scale and exposure, reflections consistent with the actual environment, restrained camera movement, and a sober color grade. Maintain continuity of vehicle identity, location, lighting, exposure, contrast, and color grade across the sequence. Avoid plastic or CGI appearance, morphing, flicker, warped wheels, tire sliding, popping objects, exaggerated HDR, impossible reflections, or day-to-night changes. ZERO ADDED TEXT: no titles, captions, overlays, added logos, or transitions. Keep plates blank or unreadable and preserve visible vehicle badges exactly as shown. The animated RIMCO logo is added only as the separate post-production end card. This is a clean standalone clip intended for assembly beside the other selected shots.`;
}

export function buildStoryboardInstruction(input: {
  durationSeconds: ClipDurationSeconds;
  mode: StoryMode;
  vehicle: string;
  vehiclePhotos: Array<{ id: string; role: string; title: string; angle?: string | null }>;
  places: Array<{ id: string; title: string; category?: string | null }>;
  purpose: 'presentation' | 'advertising';
  direction?: string;
  format: '16:9' | '9:16' | '1:1' | '4:5';
  character?: string;
  lighting?: string;
}) {
  const limits = input.mode === 'standard' ? '2 to 10' : input.mode === 'pro' ? '3 to 15' : '4 to 30';
  const purposeDirection = input.purpose === 'presentation'
    ? 'Make a faithful product presentation: open with a clear full-vehicle view, reveal only features and angles visibly supported by the references, keep movement understated, and finish on a composed exterior hero shot.'
    : 'Make a premium advertising arc: establish an evocative real Côte d’Ivoire setting, reveal the vehicle with a restrained cinematic move, and finish on a memorable exterior hero shot. Keep the creative treatment premium while keeping every vehicle detail and action plausible and reference-supported.';
  return `You are a senior automotive commercial film director and product-cinematography expert. Return only valid JSON: {"shots":[{"title":"...","scene":"...","framing":"...","location":"...","action":"...","camera":"...","durationSeconds":integer,"vehiclePhotoId":"approved photo id","locationPhotoId":"approved location id or null"}]}. Analyze the user's brief as a director and create an intentional ${input.purpose === 'presentation' ? 'faithful vehicle presentation' : 'premium automotive advertisement'} storyboard, not a generic sequence. ${purposeDirection} Generate exactly ${input.durationSeconds}s of footage in ${input.format}; a separate 2s animated brand end card is added afterward, so the final film is ${input.durationSeconds + STORYBOARD_LOGO_SECONDS}s. Use 2 to 6 distinct, connected shots, each between ${limits} seconds for ${input.mode}; distribute the exact total duration across them. Build a natural advertising progression suited to the brief: establish the chosen world, reveal the vehicle with varied wide/medium/detail framing, show the requested use or emotion, and finish with a composed hero image. Do not force beats that do not fit the short runtime or contradict the user's idea. Give every shot a deliberate framing such as wide, medium, close-up, or detail, chosen to suit the selected reference angle. The supplied, approved images are the only visual source: choose only vehiclePhotoId values from the approved vehicle photo list and only locationPhotoId values from the approved place list (or null if no place reference is chosen). Match every shot to the angle and role recorded for its selected vehicle photo. Never request a profile, rear, detail, or interior view unless a matching reference exists; when no interior reference exists, keep every shot exterior. Do not invent vehicle features, colors, trim, equipment, locations, landmarks, signage, or text. Preserve the exact same vehicle identity and proportions across all shots. Treat a vehicle photo only as the reference for the car's identity, color and visible geometry; if a separate location photo is selected, use it as the sole background reference and ignore the vehicle photo's original background. Honor requested people and story details naturally; do not add people when they are not requested. Character direction: ${input.character?.trim() || 'none unless requested in the brief'}. Lighting direction: ${input.lighting?.trim() || 'choose lighting to suit the brief and selected place'}. Plan simple, shootable actions and restrained camera moves that suit the available reference view; avoid turning the car to reveal an unseen side, implausible high-speed driving, drifting, or complex maneuvers. When the brief asks for a dirt-road or off-road scene, allow controlled movement and natural tire dust if the selected reference supports it. Favor real-world scale, natural exposure, coherent reflections, physically plausible wheels and suspension, and stable geometry. Maintain consistent exposure, contrast, and restrained color grading across the sequence while respecting the real lighting shown in each selected location; do not change day to night. Avoid plastic/CGI scenery, morphing, flicker, warped wheels, tire sliding, objects appearing or disappearing, exaggerated HDR, and impossible reflections. Use the supplied location photo to ground the setting and preserve its recognizable layout; do not add signs or readable writing. Keep license plates blank or unreadable. Keep footage free of titles, captions, overlays, added logos, and transitions; the only brand mark is the separate, animated RIMCO end card after the clips. For premium advertising, use cinematic but realistic composition, varied shot sizes, smooth camera movement, purposeful pacing, and polished automotive color grading. Use a clear visual progression, ending on a calm exterior hero shot using an available front three-quarter reference when one exists. User direction: ${input.direction?.trim() || 'No extra direction.'}. Vehicle: ${input.vehicle}. Approved vehicle photos with their visible views: ${JSON.stringify(input.vehiclePhotos)}. Approved place references: ${JSON.stringify(input.places)}.`;
}

export function buildSingleShotStoryboardInstruction(input: {
  durationSeconds: ClipDurationSeconds;
  vehicle: string;
  vehiclePhotos: Array<{ id: string; role: string; title: string; angle?: string | null }>;
  places: Array<{ id: string; title: string; category?: string | null }>;
  purpose: 'presentation' | 'advertising';
  direction?: string;
  format?: '16:9' | '9:16' | '1:1' | '4:5';
  character?: string;
  lighting?: string;
}) {
  const footageSeconds = input.durationSeconds;
  const creativeDirection = input.purpose === 'presentation'
    ? 'Create one faithful product shot that clearly presents the vehicle, using only the visible features and angle supported by its selected photo.'
    : 'Create one premium advertising hero shot with a restrained, cinematic camera move and a memorable composition grounded in the selected real Côte d’Ivoire location.';
  return `You are a senior automotive commercial film director and product-cinematography expert. Return only valid JSON: {"shots":[{"title":"...","scene":"...","framing":"...","location":"...","action":"...","camera":"...","durationSeconds":${footageSeconds},"vehiclePhotoId":"approved photo id","locationPhotoId":"approved location id or null"}]}. Analyze the user's brief and propose exactly one coherent ${input.format ?? '16:9'} advertising shot with ${input.durationSeconds} seconds of generated footage. The final video is ${input.durationSeconds + STORYBOARD_LOGO_SECONDS} seconds including a separate 2-second animated RIMCO end card. ${creativeDirection} Use only a vehiclePhotoId from the approved vehicle photos and a locationPhotoId from the approved places (or null). Select a vehicle angle appropriate to the visible reference; do not invent an interior, unseen sides, equipment, trim, landmarks, signs, colors or text. Keep the same exact vehicle identity and proportions. If a place reference is selected, it is the background and its recognizable layout must be preserved. Character direction: ${input.character?.trim() || 'none unless requested in the brief'}. Lighting direction: ${input.lighting?.trim() || 'choose lighting to suit the brief and selected place'}. Honor requested people and story details naturally. Favor a shootable action, natural light, physically plausible motion, stable geometry, credible reflections, realistic scale and restrained camera movement. For premium advertising use cinematic composition and polished realistic color grading. Avoid plastic/CGI appearance, morphing, flicker, warped wheels, tire sliding, objects appearing or disappearing, exaggerated HDR and impossible reflections. Do not add titles, captions, logos or transitions. Keep plates blank or unreadable. User direction: ${input.direction?.trim() || 'No extra direction.'}. Vehicle: ${input.vehicle}. Approved vehicle photos: ${JSON.stringify(input.vehiclePhotos)}. Approved place references: ${JSON.stringify(input.places)}.`;
}
