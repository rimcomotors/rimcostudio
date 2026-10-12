import { z } from 'zod';
import type { Brief } from '@/core/brief';

export const shotDraftSchema = z.object({
  title: z.string().trim().min(1).max(80),
  scene: z.string().trim().min(1).max(160),
  location: z.string().trim().min(1).max(160),
  action: z.string().trim().min(1).max(180),
  camera: z.string().trim().min(1).max(160),
}).strict();

export const storyboardSchema = z.array(shotDraftSchema).length(2);
export type StoryboardShot = z.infer<typeof shotDraftSchema>;

/** Build one independent generation prompt while keeping vehicle and look consistent. */
export function shotToPrompt(brief: Brief, shot: StoryboardShot, index: number): string {
  const shotNumber = index + 1;
  const character = brief.character === 'Aucun personnage' ? 'none; do not add people' : brief.character || 'none; do not add people';
  return `Create one 3-second ${brief.format} image-to-video automotive shot, shot ${shotNumber} of 2. Scene: ${shot.scene}. Location: ${shot.location}. Action: ${shot.action}. Camera: ${shot.camera}. Lighting: ${brief.lighting}. Mood: ${brief.mood}. Creative direction: ${brief.creative_direction || brief.user_direction || 'Premium, natural automotive storytelling.'}. Vehicle identity must remain exactly faithful to the supplied reference photo: ${brief.vehicle_description}; do not alter its model, proportions, wheels, lights, or paint. Character: ${character}. Use a clean composition with approximately 90% blue and 10% red tones. This is a standalone shot that will be edited beside another shot; do not add transitions, cuts, titles, logos, captions, or text.`;
}
