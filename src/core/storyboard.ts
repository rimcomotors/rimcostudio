import { z } from 'zod';
import type { Brief } from '@/core/brief';

export const storyModeSchema = z.enum(['standard', 'pro', 'premium']);
export type StoryMode = z.infer<typeof storyModeSchema>;
export type StoryProvider = 'wan' | 'kling' | 'seedance';
export type ClipDurationSeconds = 5 | 10 | 15 | 20;

export function compactStoryboardText(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length <= maxLength) return text;

  const candidate = text.slice(0, maxLength + 1);
  const sentenceEnd = Math.max(candidate.lastIndexOf('.'), candidate.lastIndexOf('!'), candidate.lastIndexOf('?'));
  const wordEnd = candidate.lastIndexOf(' ');
  const end = sentenceEnd >= maxLength * 0.55 ? sentenceEnd + 1 : wordEnd;
  return text.slice(0, end > 0 ? end : maxLength).trim().replace(/[,;:–—-]+$/, '');
}

const storyboardText = (maxLength: number) => z.string().trim().min(1).max(2_000).transform((value) => compactStoryboardText(value, maxLength));

export const shotDraftSchema = z.object({
  title: storyboardText(80),
  scene: storyboardText(160),
  framing: storyboardText(120).default('Plan moyen'),
  location: storyboardText(160),
  action: storyboardText(180),
  camera: storyboardText(160),
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
export const PREMIUM_AD_CLIP_SECONDS = 4;
export const PREMIUM_AD_SHOT_COUNT = 4;
export const PREMIUM_AD_SHOT_OUTPUT_SECONDS = 2.5;
export const PREMIUM_FIXED_DURATION_SECONDS = 20;
export const PREMIUM_FIXED_SHOT_SECONDS = 5;
export const PREMIUM_FIXED_SHOT_COUNT = PREMIUM_FIXED_DURATION_SECONDS / PREMIUM_FIXED_SHOT_SECONDS;
const providerLimits: Record<StoryProvider, { min: number; max: number }> = {
  wan: { min: 5, max: 5 },
  kling: { min: 3, max: 15 },
  seedance: { min: 4, max: 30 },
};

export function finalVideoSeconds(clipDurationSeconds: ClipDurationSeconds): number {
  return clipDurationSeconds + STORYBOARD_LOGO_SECONDS;
}

export function isTierDurationSupported(mode: StoryMode, durationSeconds: ClipDurationSeconds): boolean {
  return mode !== 'premium' || durationSeconds === PREMIUM_FIXED_DURATION_SECONDS;
}

export function validateTierDuration(mode: StoryMode, durationSeconds: ClipDurationSeconds): true {
  if (!isTierDurationSupported(mode, durationSeconds)) {
    throw new Error('Le niveau Premium est disponible uniquement en 20 secondes, logo final inclus après le montage.');
  }
  return true;
}

export function validatePremiumTwentySecondStoryboard(shots: StoryboardShot[]): true {
  const parsed = storyboardSchema.parse(shots);
  if (parsed.length !== PREMIUM_FIXED_SHOT_COUNT || parsed.some((shot) => shot.durationSeconds !== PREMIUM_FIXED_SHOT_SECONDS)) {
    throw new Error('Une vidéo Premium de 20 secondes doit contenir exactement quatre plans de 5 secondes.');
  }
  return true;
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
  const peopleDirection = /^(?:aucun personnage|none(?:; do not add people)?|no people)$/i.test(character.trim())
    ? 'No visible driver, passenger, face, person, or human silhouette inside or outside the vehicle. The vehicle is visually unoccupied; keep every window empty, dark, or reflective.'
    : `Character: ${character}.`;
  const marker = (index: number) => referenceMarker === '@' ? `@Image${index}` : `[Image${index}]`;
  const view = [vehicleView?.role, vehicleView?.angle].filter((value) => typeof value === 'string' && value.trim()).join(', ');
  const vehicleReference = `Use ${marker(1)} (approved vehicle photo ${shot.vehiclePhotoId}${view ? `, showing ${view}` : ''}) as the authoritative vehicle identity and visible-view reference`;
  const locationReference = shot.locationPhotoId ? `Use ${marker(2)} (approved Côte d’Ivoire location photo ${shot.locationPhotoId}) as the only background and actual visual setting; preserve its recognizable landmarks and layout. Use the vehicle photo only for vehicle identity and visible geometry; ignore its original background.` : `Use the selected real Côte d’Ivoire location: ${shot.location}. Use the vehicle photo only for vehicle identity and visible geometry; do not copy its original background.`;
  return `Create one ${shot.durationSeconds}-second ${brief.format} image-to-video automotive shot, shot ${index + 1} of ${shotCount}. Create a premium, photorealistic automotive commercial in real-world live-action style. Use the attached approved assets as the only visual sources. VEHICLE: ${brief.vehicle_description}. ${vehicleReference}; preserve its exact silhouette, front and rear details, paint color, wheels, badges, proportions, and visible equipment across every shot. Show only surfaces and angles supported by the selected photo; never invent an unseen side, interior, trim, or feature. LOCATION: ${shot.location}. ${locationReference} Preserve the supplied place's real geometry, recognizable landmarks, architecture, road layout, and natural light; do not add buildings or signs. SHOT ${index + 1}/${shotCount}: Scene: ${shot.scene}. Framing: ${shot.framing}. Action: ${shot.action}. Camera: ${shot.camera}. Speed: normal live-action speed; no speed ramps. Effects: only natural environmental effects requested by the brief, such as dust from a dirt road; no synthetic visual effects. Edit transition: a clean cut between clips; do not synthesize a transition. Lighting: ${brief.lighting}. Mood: ${brief.mood}. Creative direction: premium, elegant, restrained automotive advertising; keep the vehicle the clear hero. Additional user direction: ${brief.user_direction || 'none; do not contradict the approved vehicle and location references'}. ${peopleDirection} REALISM: Physically credible wheel rotation and suspension, stable geometry, natural scale and exposure, reflections consistent with the actual environment, restrained camera movement, and a sober color grade. Maintain continuity of vehicle identity, location, lighting, exposure, contrast, and color grade across the sequence. Avoid plastic or CGI appearance, morphing, flicker, warped wheels, tire sliding, popping objects, exaggerated HDR, impossible reflections, or day-to-night changes. ZERO ADDED TEXT: no titles, captions, overlays, added logos, or transitions. Keep plates blank or unreadable and preserve visible vehicle badges exactly as shown. The animated RIMCO logo is added only as the separate post-production end card. This is a clean standalone clip intended for assembly beside the other selected shots.`;
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
  const premiumTenSecondAd = input.mode === 'premium' && input.purpose === 'advertising' && input.durationSeconds === 10;
  const premiumTwentySecond = input.mode === 'premium' && input.durationSeconds === PREMIUM_FIXED_DURATION_SECONDS;
  const limits = input.mode === 'standard' ? 'exactly 5' : input.mode === 'pro' ? '3 to 15' : '4 to 30';
  const purposeDirection = input.purpose === 'presentation'
    ? 'Make a faithful product presentation: open with a clear full-vehicle view, reveal only features and angles visibly supported by the references, keep movement understated, and finish on a composed exterior hero shot.'
    : 'Make a premium advertising arc: establish an evocative real Côte d’Ivoire setting, reveal the vehicle with a restrained cinematic move, and finish on a memorable exterior hero shot. Keep the creative treatment premium while keeping every vehicle detail and action plausible and reference-supported.';
  const shotCount = premiumTenSecondAd || premiumTwentySecond ? PREMIUM_AD_SHOT_COUNT : input.durationSeconds / 5;
  const shotCountDirection = premiumTenSecondAd
    ? `Use exactly ${shotCount} distinct shots. Their editorial durations must total exactly 10 seconds; use a mix of 2- and 3-second cuts. Each will be generated as a separate 4-second image-to-video clip and trimmed during editing.`
    : premiumTwentySecond
      ? 'Use exactly four distinct shots of exactly 5 seconds each. Generate each as an independent 5-second image-to-video clip; preserve the full 20-second edit without trimming. Build a clear premium trailer arc: establish the location, reveal the whole vehicle, show one reference-supported detail or movement, then finish on a composed hero shot. Keep visual continuity and vary framing without inventing unsupported vehicle views.'
      : `Use exactly ${shotCount} shots and make every shot exactly 5 seconds. This fixed duration keeps the complete sequence within ${input.mode} provider limits.`;
  const durationDirection = premiumTenSecondAd
    ? 'Each editorial shot must last two or three seconds and the four cuts must total exactly ten seconds.'
    : premiumTwentySecond
      ? 'Every shot lasts exactly five seconds; all four shots total exactly twenty seconds before the two-second logo end card.'
    : `Each shot must be ${limits} seconds for ${input.mode}.`;
  const characterDirection = premiumTenSecondAd
    ? 'Absolutely no people anywhere in any shot: no driver, passenger, face, silhouette, or human reflection, including inside the vehicle. All windows remain empty, dark, or reflective.'
    : `Honor requested people and story details naturally; do not add people when they are not requested. Character direction: ${input.character?.trim() || 'none unless requested in the brief'}.`;
  return `You are a senior automotive commercial film director and product-cinematography expert. Return only valid JSON: {"shots":[{"title":"...","scene":"...","framing":"...","location":"...","action":"...","camera":"...","durationSeconds":integer,"vehiclePhotoId":"approved photo id","locationPhotoId":"approved location id or null"}]}. Keep every text value concise and within its exact limit: title 80 characters, scene 160, framing 120, location 160, action 180, camera 160. Never exceed these limits; use one short sentence per field. Analyze the user's brief as a director and create an intentional ${input.purpose === 'presentation' ? 'faithful vehicle presentation' : 'premium automotive advertisement'} storyboard, not a generic sequence. ${purposeDirection} Generate exactly ${input.durationSeconds}s of footage in ${input.format}; a separate 2s animated brand end card is added afterward, so the final film is ${input.durationSeconds + STORYBOARD_LOGO_SECONDS}s. ${shotCountDirection} ${durationDirection} Build a natural advertising progression suited to the brief: establish the chosen world, reveal the vehicle with varied wide/medium/detail framing, show the requested use or emotion, and finish with a composed hero image. Do not force beats that do not fit the short runtime or contradict the user's idea. Give every shot a deliberate framing such as wide, medium, close-up, or detail, chosen to suit the selected reference angle. The supplied, approved images are the only visual source: choose only vehiclePhotoId values from the approved vehicle photo list and only locationPhotoId values from the approved place list (or null if no place reference is chosen). Match every shot to the angle and role recorded for its selected vehicle photo. Never request a profile, rear, detail, or interior view unless a matching reference exists; when no interior reference exists, keep every shot exterior. A macro or close-up detail is allowed only when that exact detail is clearly visible in a supplied approved vehicle photo; otherwise use a view supported by the photos. Do not invent vehicle features, colors, trim, equipment, locations, landmarks, signage, or text. Preserve the exact same vehicle identity and proportions across all shots. Treat a vehicle photo only as the reference for the car's identity, color and visible geometry; if a separate location photo is selected, use it as the sole background reference and ignore the vehicle photo's original background. ${characterDirection} Lighting direction: ${input.lighting?.trim() || 'choose lighting to suit the brief and selected place'}. Plan simple, shootable actions and restrained camera moves that suit the available reference view; avoid turning the car to reveal an unseen side, implausible high-speed driving, drifting, or complex maneuvers. When the brief asks for a dirt-road or off-road scene, allow controlled movement and natural tire dust if the selected reference supports it. Favor real-world scale, natural exposure, coherent reflections, physically plausible wheels and suspension, and stable geometry. Maintain consistent exposure, contrast, and restrained color grading across the sequence while respecting the real lighting shown in each selected location; do not change day to night. Avoid plastic/CGI scenery, morphing, flicker, warped wheels, tire sliding, objects appearing or disappearing, exaggerated HDR, and impossible reflections. Use the supplied location photo to ground the setting and preserve its recognizable layout; do not add signs or readable writing. Keep license plates blank or unreadable. Keep footage free of titles, captions, overlays, added logos, and transitions; the only brand mark is the separate, animated RIMCO end card after the clips. For premium advertising, use cinematic but realistic composition, varied shot sizes, smooth camera movement, purposeful pacing, and polished automotive color grading. Use a clear visual progression, ending on a calm exterior hero shot using an available front three-quarter reference when one exists. User direction: ${input.direction?.trim() || 'No extra direction.'}. Vehicle: ${input.vehicle}. Approved vehicle photos with their visible views: ${JSON.stringify(input.vehiclePhotos)}. Approved place references: ${JSON.stringify(input.places)}.`;
}

export function isPremiumTenSecondAd(mode: StoryMode, purpose: 'presentation' | 'advertising', durationSeconds: number) {
  return mode === 'premium' && purpose === 'advertising' && durationSeconds === 10;
}

export function premiumTenSecondAdDurations() {
  return {
    generated: Array.from({ length: PREMIUM_AD_SHOT_COUNT }, () => PREMIUM_AD_CLIP_SECONDS),
    editorial: Array.from({ length: PREMIUM_AD_SHOT_COUNT }, () => PREMIUM_AD_SHOT_OUTPUT_SECONDS),
  };
}

export function validatePremiumTenSecondAdStoryboard(shots: StoryboardShot[]) {
  const parsed = storyboardSchema.parse(shots);
  if (parsed.length !== PREMIUM_AD_SHOT_COUNT || parsed.reduce((sum, shot) => sum + shot.durationSeconds, 0) !== 10) {
    throw new Error('Le réalisateur doit préparer exactement quatre plans totalisant dix secondes.');
  }
  if (parsed.some((shot) => shot.durationSeconds < 2 || shot.durationSeconds > 3)) {
    throw new Error('Chaque plan Premium de dix secondes doit durer deux ou trois secondes au montage.');
  }
  return true;
}

export function fitStoryboardDurations(shots: StoryboardShot[], totalSeconds: ClipDurationSeconds, provider: StoryProvider): StoryboardShot[] {
  const { min, max } = providerLimits[provider];
  const minimumCount = Math.ceil(totalSeconds / max);
  const maximumCount = Math.floor(totalSeconds / min);
  if (minimumCount > maximumCount || maximumCount < 2) throw new Error('Impossible de répartir cette durée entre plusieurs plans compatibles avec le modèle sélectionné.');

  const count = Math.max(minimumCount, Math.min(shots.length, maximumCount));
  const selected = count === shots.length
    ? shots
    : Array.from({ length: count }, (_, index) => shots[Math.round(index * (shots.length - 1) / (count - 1))]);
  const baseDuration = Math.floor(totalSeconds / count);
  const remainder = totalSeconds % count;

  return selected.map((shot, index) => ({
    ...shot,
    durationSeconds: baseDuration + (index < remainder ? 1 : 0),
  }));
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
