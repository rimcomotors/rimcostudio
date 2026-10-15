import { z } from 'zod';
import { vehicleCategories } from '@/core/scenes/catalog';
export const requestSchema = z.object({
  description: z.string().trim().max(500).default(''),
  title: z.string().trim().max(120).default(''),
  assetId: z.string().min(1),
  audioAssetId: z.string().min(1).nullable().optional(),
  overlayLogo: z.boolean().default(true),
  location: z.string().max(160).default(''),
  setting: z.string().max(160).default(''),
  character: z.string().max(160).default(''),
  lighting: z.string().max(160).default('golden hour'),
  cameraMovement: z.string().trim().max(160).default('Travelling trois-quarts avant, stable et sans coupe'),
  vehicleAction: z.string().trim().max(160).default('Le véhicule avance lentement et régulièrement'),
  mood: z.string().trim().max(160).default('Moderne, naturel et rassurant'),
  vehicleCategory: z.enum(vehicleCategories).default('autre'),
  scenePresetId: z.string().trim().max(100).default(''),
  conceptId: z.enum(['signature', 'mouvement', 'ambiance']).default('signature'),
  format: z.enum(['16:9','9:16','1:1','4:5']).default('16:9'),
  tier: z.enum(['standard','pro','premium','test']).default('standard'),
  durationS: z.union([z.literal(5), z.literal(6), z.literal(10), z.literal(15), z.literal(20), z.literal(30)]).default(5),
  complexity: z.enum(['simple','balanced','rich']).default('simple'),
  modelId: z.string().uuid().optional(),
});
