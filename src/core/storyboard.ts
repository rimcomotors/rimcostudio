import { z } from 'zod';
import type { Brief } from '@/core/brief';

export const storyModeSchema = z.enum(['standard', 'pro', 'premium']);
export type StoryMode = z.infer<typeof storyModeSchema>;
export type StoryProvider = 'wan' | 'kling' | 'seedance';

export const shotDraftSchema = z.object({
  title: z.string().trim().min(1).max(80),
  scene: z.string().trim().min(1).max(160),
  location: z.string().trim().min(1).max(160),
  action: z.string().trim().min(1).max(180),
  camera: z.string().trim().min(1).max(160),
  durationSeconds: z.number().int().min(2).max(30),
  vehiclePhotoId: z.string().trim().min(1).max(100),
  locationPhotoId: z.string().trim().min(1).max(100).nullable().optional(),
}).strict();

export const storyboardSchema = z.array(shotDraftSchema).min(2).max(6);
export type StoryboardShot = z.infer<typeof shotDraftSchema>;

export const STORYBOARD_LOGO_SECONDS = 2;
const providerLimits: Record<StoryProvider, { min: number; max: number }> = {
  wan: { min: 2, max: 10 },
  kling: { min: 3, max: 15 },
  seedance: { min: 4, max: 30 },
};

export function generatedVideoSeconds(finalDurationSeconds: 15 | 20): number {
  return finalDurationSeconds - STORYBOARD_LOGO_SECONDS;
}

export function validateStoryboard(shots: StoryboardShot[], finalDurationSeconds: 15 | 20, provider: StoryProvider): true {
  const parsed = storyboardSchema.parse(shots);
  const expected = generatedVideoSeconds(finalDurationSeconds);
  const total = parsed.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  if (total !== expected) throw new Error(`La durée des plans doit être exactement de ${expected} secondes avant le logo.`);
  const limits = providerLimits[provider];
  if (parsed.some((shot) => shot.durationSeconds < limits.min || shot.durationSeconds > limits.max)) {
    throw new Error(`Chaque plan doit durer entre ${limits.min} et ${limits.max} secondes maximum pour ce modèle.`);
  }
  return true;
}

export function shotToPrompt(brief: Brief, shot: StoryboardShot, index: number, shotCount: number, referenceMarker: '@' | '[' = '@'): string {
  const character = brief.character === 'Aucun personnage' ? 'none; do not add people' : brief.character || 'none; do not add people';
  const marker = (index: number) => referenceMarker === '@' ? `@Image${index}` : `[Image${index}]`;
  const vehicleReference = `Use ${marker(1)} (approved vehicle photo ${shot.vehiclePhotoId}) as the authoritative vehicle identity reference`;
  const locationReference = shot.locationPhotoId ? `Use ${marker(2)} (approved Côte d’Ivoire location photo ${shot.locationPhotoId}) as the actual visual setting; preserve recognizable landmarks and layout.` : `Use the selected real Côte d’Ivoire location: ${shot.location}.`;
  return `Create one ${shot.durationSeconds}-second 16:9 image-to-video automotive shot, shot ${index + 1} of ${shotCount}. Scene: ${shot.scene}. Location: ${shot.location}. ${locationReference} Action: ${shot.action}. Camera: ${shot.camera}. Lighting: ${brief.lighting}. Mood: ${brief.mood}. Creative direction: ${brief.creative_direction || brief.user_direction || 'Premium, natural automotive storytelling.'}. Vehicle identity must remain exactly faithful to the supplied vehicle reference: ${vehicleReference}; ${brief.vehicle_description}; do not alter its model, proportions, wheels, lights, interior details, or paint. Character: ${character}. Use realistic photographic lighting, natural camera motion, coherent physical scale, and no synthetic 3D appearance. This is a standalone shot to be edited beside other shots; do not add titles, logos, captions, text, or transitions.`;
}

export function buildStoryboardInstruction(input: {
  durationSeconds: 15 | 20;
  mode: StoryMode;
  vehicle: string;
  vehiclePhotos: Array<{ id: string; role: string; title: string }>;
  places: Array<{ id: string; title: string; category?: string | null }>;
  purpose: 'presentation' | 'advertising';
  direction?: string;
}) {
  const targetSeconds = generatedVideoSeconds(input.durationSeconds);
  const limits = input.mode === 'standard' ? '2 to 10' : input.mode === 'pro' ? '3 to 15' : '4 to 30';
  return `You are a senior automotive commercial film director and product-cinematography expert. Return only valid JSON: {"shots":[{"title":"...","scene":"...","location":"...","action":"...","camera":"...","durationSeconds":integer,"vehiclePhotoId":"approved photo id","locationPhotoId":"approved location id or null"}]}. Create a premium, photorealistic ${input.purpose === 'presentation' ? 'faithful vehicle presentation' : 'automotive advertisement'} storyboard. Final film duration is ${input.durationSeconds}s including a separate 2s animated brand end card; generated shots must total exactly ${targetSeconds}s. Use 2 to 6 shots, each between ${limits} seconds for ${input.mode}. Choose only vehiclePhotoId values from the approved vehicle photo list and only locationPhotoId values from the approved place list (or null if no place reference is chosen). Never invent vehicle features, colors, locations, landmarks, or text. Choose the photo angle that matches each shot, including interior shots only when an interior reference exists. Keep the product recognizable across all shots. Favor restrained camera movements, real-world scale and natural light; avoid CGI/3D-looking scenery. User direction: ${input.direction?.trim() || 'No extra direction.'}. Vehicle: ${input.vehicle}. Approved vehicle photos: ${JSON.stringify(input.vehiclePhotos)}. Approved place references: ${JSON.stringify(input.places)}.`;
}
