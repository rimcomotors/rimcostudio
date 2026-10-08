import { createFalClient } from '@fal-ai/client';
import { z } from 'zod';
import { briefSchema, generatedBriefFieldsSchema } from '@/core/brief';
import { env } from '@/env';
import type { Brief } from '@/core/brief';
import type { LlmProvider } from './contracts';

export const FAL_LLM_ENDPOINT = 'openrouter/router';
export class FalLlmBriefError extends Error {
  constructor(message: string, readonly completedRequests: number, readonly reportedCostUsd: number | null) {
    super(message);
    this.name = 'FalLlmBriefError';
  }
}
const fields = ['location', 'setting', 'character', 'lighting', 'camera_movement', 'mood', 'format', 'creative_direction'] as const;
const fieldNames = fields.join(', ');
const systemPrompt = `Tu es le directeur de création vidéo automobile de RIMCO. Tu comprends une demande en français et renvoies uniquement un objet JSON valide, sans markdown. Les valeurs textuelles doivent être en français. Les seules clés autorisées sont: ${fieldNames}. Renseigne toutes ces clés pour le brief initial. Respecte les options déjà choisies, notamment la durée, la complexité, le moment et la lumière (y compris une scène de nuit) et l’absence explicite de personnage. creative_direction doit adapter le rythme au temps disponible et à la complexité choisie, en restant cohérente avec les options, sans ajouter de lieu, personnage, véhicule ou action contradictoire. format doit être l'une de: 16:9, 9:16, 1:1, 4:5. Ne crée jamais de description de véhicule, ne change jamais son identité, sa marque, son modèle ni sa couleur: la photo choisie est la seule référence. Tout reste dans un plan continu sans coupe.`;

type FalSubscribe = (endpoint: string, options: { input: Record<string, string | number | boolean> }) => Promise<unknown>;
export type LlmCall = (prompt: string, systemPrompt: string) => Promise<unknown>;

export function buildFalLlmInput(prompt: string, systemPrompt: string, model: string) {
  return {
    prompt,
    system_prompt: systemPrompt,
    model,
    reasoning: true,
    temperature: 0.2,
    max_tokens: 1200,
  } as const;
}

function outputText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'output' in result) {
    const output = (result as { output?: unknown }).output;
    if (typeof output === 'string') return output;
    if (output && typeof output === 'object') return JSON.stringify(output);
  }
  if (result && typeof result === 'object' && 'data' in result) return outputText((result as { data: unknown }).data);
  throw new Error('Le fournisseur LLM n’a pas retourné de champ output exploitable.');
}

function parseJson(text: string): unknown {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(normalized) as unknown;
}

async function validatedFields<T>(call: LlmCall, prompt: string, schema: z.ZodType<T>) {
  let lastIssue = 'La réponse ne respecte pas le format attendu.';
  let costUsd = 0;
  let hasReportedCost = false;
  let completedRequests = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
      const request = attempt === 0 ? prompt : `${prompt}\n\nCorrection obligatoire: la réponse précédente était invalide (${lastIssue}). Renvoie un objet JSON valide avec uniquement les clés autorisées: ${fieldNames}.`;
    let response: unknown;
    try {
      response = await call(request, systemPrompt);
    } catch {
      throw new FalLlmBriefError('L’appel au fournisseur LLM a échoué.', completedRequests, hasReportedCost ? costUsd : null);
    }
    completedRequests += 1;
    const reportedCost = responseCost(response);
    if (reportedCost !== null) {
      costUsd += reportedCost;
      hasReportedCost = true;
    }
    try {
      const fieldsResult = schema.safeParse(parseJson(outputText(response)));
      if (fieldsResult.success) return { fields: fieldsResult.data, costUsd: hasReportedCost ? costUsd : null };
      lastIssue = fieldsResult.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    } catch (error) {
      lastIssue = error instanceof Error ? error.message : 'Réponse invalide.';
    }
  }
  throw new FalLlmBriefError(`Impossible de construire un brief vidéo valide après une nouvelle tentative : ${lastIssue}`, completedRequests, hasReportedCost ? costUsd : null);
}

function responseCost(response: unknown): number | null {
  if (!response || typeof response !== 'object') return null;
  const root = response as { usage?: { cost?: unknown }; data?: { usage?: { cost?: unknown } } };
  const cost = root.data?.usage?.cost ?? root.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

export function createFalLlmProvider(call: LlmCall) {
  return {
    async buildBrief(description: string, options: Record<string, string>) {
      return (await this.buildBriefWithCost(description, options)).brief;
    },
    async buildBriefWithCost(description: string, options: Record<string, string>) {
      const prompt = `À partir de cette demande utilisateur, construis le brief vidéo RIMCO. Garde la demande fidèle et concise. Les options déjà choisies doivent être respectées: ${JSON.stringify(options)}. La creative_direction doit bien les synthétiser sans ajouter de détails contradictoires.\nDemande complémentaire: ${description || 'Aucune; compose uniquement à partir des options choisies.'}`;
      const generated = await validatedFields(call, prompt, generatedBriefFieldsSchema);
      const selectedOptions = Object.fromEntries(Object.entries(options).filter(([key, value]) => key === 'vehicle_asset_id' || key === 'vehicle_description' || value.trim().length > 0));
      return { brief: briefSchema.parse({ vehicle_asset_id: options.vehicle_asset_id || 'mock-vehicle', vehicle_description: options.vehicle_description || description, ...generated.fields, ...selectedOptions, duration_s: Number(options.duration_s ?? 5) }), costUsd: generated.costUsd };
    },
  } satisfies LlmProvider & {
    buildBriefWithCost(description: string, options: Record<string, string>): Promise<{ brief: Brief; costUsd: number | null }>;
  };
}

function falCall(): LlmCall {
  const fal = createFalClient({ credentials: env.FAL_KEY ?? '' });
  const subscribe = fal.subscribe as unknown as FalSubscribe;
  return async (prompt, system_prompt) => subscribe(FAL_LLM_ENDPOINT, {
    input: buildFalLlmInput(prompt, system_prompt, env.LLM_MODEL ?? ''),
  });
}

export const falLlmProvider: LlmProvider = {
  async buildBrief(description, options) {
    if (!env.FAL_KEY) throw new Error('FAL_KEY manque : configurez la clé fal.ai dans Vercel.');
    if (!env.LLM_MODEL) throw new Error('LLM_MODEL manque : choisissez un modèle disponible sur fal.ai.');
    return createFalLlmProvider(falCall()).buildBrief(description, options);
  },
};

export async function buildFalBriefWithCost(description: string, options: Record<string, string>) {
  if (!env.FAL_KEY) throw new Error('FAL_KEY manque : configurez la clé fal.ai dans Vercel.');
  if (!env.LLM_MODEL) throw new Error('LLM_MODEL manque : choisissez un modèle disponible sur fal.ai.');
  return createFalLlmProvider(falCall()).buildBriefWithCost(description, options);
}
