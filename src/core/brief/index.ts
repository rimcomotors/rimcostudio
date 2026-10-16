import { z } from 'zod';
import { vehicleCategories } from '@/core/scenes/catalog';

export const briefSchema = z.object({
  vehicle_asset_id: z.string().min(1),
  vehicle_description: z.string().trim().min(1).max(500),
  vehicle_category: z.enum(vehicleCategories).default('autre'),
  scene_preset_id: z.string().trim().max(100).default(''),
  vehicle_action: z.string().trim().max(160).default('Le véhicule avance lentement et régulièrement'),
  user_direction: z.string().trim().max(500).default(''),
  creative_direction: z.string().trim().max(500).default(''),
  location: z.string().trim().max(160).default(''),
  setting: z.string().trim().max(160).default(''),
  character: z.string().trim().max(160).default(''),
  lighting: z.string().trim().max(160).default('golden hour'),
  camera_movement: z.string().trim().max(160).default('slow tracking shot'),
  mood: z.string().trim().max(160).default('confident'),
  format: z.enum(['16:9', '9:16', '1:1', '4:5']).default('16:9'),
  duration_s: z.number().int().min(2).max(30).default(5),
  complexity: z.enum(['simple', 'balanced', 'rich']).default('simple'),
});
export type Brief = z.infer<typeof briefSchema>;
export const briefOptionsSchema = briefSchema.omit({ vehicle_asset_id: true, vehicle_description: true }).partial();

/** Fields the language model may propose; asset identity and duration stay server-owned. */
export const generatedBriefFieldsSchema = z.object({
  location: z.string().trim().max(160),
  setting: z.string().trim().max(160),
  character: z.string().trim().max(160),
  lighting: z.string().trim().max(160),
  camera_movement: z.string().trim().max(160),
  mood: z.string().trim().max(160),
  creative_direction: z.string().trim().min(1).max(500),
  format: z.enum(['16:9', '9:16', '1:1', '4:5']),
}).strict();
export function buildBrief(description: string, options: Partial<Brief> & { vehicle_asset_id?: string }): Brief {
  return briefSchema.parse({ vehicle_asset_id: options.vehicle_asset_id ?? 'mock-vehicle', vehicle_description: description, ...options });
}

export function briefToPrompt(brief: Brief, family: string): string {
  const cameraGuidance = family === 'veo'
    ? 'Use a single continuous take and avoid introducing unrequested objects.'
    : family === 'wan' ? 'Favor smooth restrained motion and strong consistency with the reference image.' : 'Use one controlled camera move with no scene cut.';
  const character = brief.character === 'Aucun personnage' ? 'none; do not add people' : brief.character || 'none; do not add people';
  const pacing = brief.duration_s <= 10
    ? 'Keep the visual story concise: establish the vehicle, perform one clear action, and finish on a composed hero frame.'
    : brief.duration_s <= 15
      ? 'Pace the continuous take in two readable beats: establish the scene, then complete the vehicle action and settle into a hero frame.'
      : brief.duration_s <= 20
        ? 'Pace the continuous take in three connected beats: establish the scene, reveal the vehicle through one controlled move, and end on a clean hero frame.'
        : 'Use a deliberate four-part progression in the same uninterrupted take: establish, approach, reveal, and hold a composed hero frame. Avoid repetitive motion or filler.';
  const complexity = brief.complexity === 'simple'
    ? 'Low complexity: one vehicle action, one camera move, no new props or scene changes.'
    : brief.complexity === 'balanced'
      ? 'Balanced complexity: two closely related visual beats with one camera move; preserve an uncluttered background.'
      : 'Higher complexity: up to three coordinated visual beats, all physically plausible and within the same location and continuous camera take.';
  return `Create a ${brief.duration_s}-second ${brief.format} image-to-video commercial. Keep the vehicle exactly faithful to the provided reference photo: ${brief.vehicle_description}. Vehicle category: ${brief.vehicle_category}. Location: ${brief.location || brief.setting || 'modern urban architecture'}. Setting: ${brief.setting || 'clean, uncluttered surroundings'}. Vehicle action: ${brief.vehicle_action}. Character: ${character}. Lighting: ${brief.lighting}. Camera: ${brief.camera_movement}. Mood: ${brief.mood}. Creative direction: ${brief.creative_direction || 'A polished, realistic automotive shot that follows the selected scene.'}. Additional user direction: ${brief.user_direction || 'none; do not contradict the selected scene'}. ${pacing} ${complexity} Use one continuous shot, a simple composition, natural people only if explicitly selected, and about 90% blue and 10% red tones. ${cameraGuidance} Do not alter the vehicle identity, model, proportions, or paint.`;
}
