import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildFalLlmInput, createFalLlmProvider } from './fal-llm';

const generated = {
  location: 'Abidjan', setting: 'architecture contemporaine', character: 'conductrice naturelle',
  lighting: 'lumière douce de fin de journée', camera_movement: 'travelling latéral lent', mood: 'assurance premium', format: '9:16', creative_direction: 'Un travelling fluide révèle la voiture dans une lumière de fin de journée.',
};

describe('fal LLM brief adapter', () => {
  it('uses the provider-compatible reasoning setting and allows enough tokens for a complete storyboard', () => {
    expect(buildFalLlmInput('brief', 'system', 'anthropic/claude-sonnet-5.5')).toEqual({
      prompt: 'brief', system_prompt: 'system', model: 'anthropic/claude-sonnet-5.5',
      reasoning: true, temperature: 0.2, max_tokens: 4000,
    });
  });

  it('retries a partial provider response with a concise instruction, then accepts valid JSON', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ data: { output: JSON.stringify({ shots: [] }), partial: true, usage: { cost: 0.01 } } })
      .mockResolvedValueOnce({ data: { output: JSON.stringify({ shots: [] }), partial: false, usage: { cost: 0.01 } } });
    const schema = z.object({ shots: z.array(z.string()) });
    const result = await createFalLlmProvider(call).buildStoryboardWithCost('brief', schema, 'JSON only');
    expect(result).toMatchObject({ fields: { shots: [] }, costUsd: 0.02 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toContain('Correction obligatoire');
    expect(call.mock.calls[1][0]).toContain('compact');
    expect(call.mock.calls[1][0]).toContain('reasoning');
  });

  it('extracts a complete JSON object surrounded by model prose or a markdown fence', async () => {
    const call = vi.fn().mockResolvedValue({ output: `Voici le storyboard demandé :\n\n\`\`\`json\n${JSON.stringify({ shots: ['plan 1'] })}\n\`\`\`` });
    const schema = z.object({ shots: z.array(z.string()) });
    await expect(createFalLlmProvider(call).buildStoryboardWithCost('brief', schema, 'JSON only'))
      .resolves.toMatchObject({ fields: { shots: ['plan 1'] } });
  });

  it('recovers from a truncated first answer with a compact second answer', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ output: '{\"shots\":[{\"title\":\"Plan interrompu' })
      .mockResolvedValueOnce({ output: JSON.stringify({ shots: ['plan 1'] }) });
    const schema = z.object({ shots: z.array(z.string()) });
    await expect(createFalLlmProvider(call).buildStoryboardWithCost('brief', schema, 'JSON only'))
      .resolves.toMatchObject({ fields: { shots: ['plan 1'] } });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toContain('Correction obligatoire');
    expect(call.mock.calls[1][0]).toContain('JSON compact');
  });

  it('builds a validated structured brief and anchors vehicle identity and duration server-side', async () => {
    const call = vi.fn().mockResolvedValue({ output: JSON.stringify(generated) });
    const brief = await createFalLlmProvider(call).buildBrief('Une Haval H6 dans Abidjan', { vehicle_asset_id: 'asset-42', format: '16:9' });
    expect(brief).toMatchObject({ ...generated, vehicle_asset_id: 'asset-42', vehicle_description: 'Une Haval H6 dans Abidjan', format: '16:9', duration_s: 5, vehicle_category: 'autre' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toContain('Demande complémentaire: Une Haval H6 dans Abidjan');
  });

  it('retries once when JSON fails schema validation, then returns a useful error if still invalid', async () => {
    const call = vi.fn().mockResolvedValueOnce({ output: '{\"format\":\"square\"}' }).mockResolvedValueOnce({ output: '{\"format\":\"square\"}' });
    await expect(createFalLlmProvider(call).buildBrief('SUV en ville', { vehicle_asset_id: 'asset-1' })).rejects.toThrow('après une nouvelle tentative');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toContain('Correction obligatoire');
  });

  it('rejects additional model-supplied keys instead of trusting arbitrary JSON', async () => {
    const call = vi.fn().mockResolvedValue({ output: JSON.stringify({ ...generated, vehicle_description: 'different car' }) });
    await expect(createFalLlmProvider(call).buildBrief('SUV bleu', { vehicle_asset_id: 'asset-1' })).rejects.toThrow('après une nouvelle tentative');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('preserves reported LLM cost when all completed responses fail validation', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ output: '{bad json', usage: { cost: 0.012 } })
      .mockResolvedValueOnce({ output: '{still bad', usage: { cost: 0.018 } });
    const error = await createFalLlmProvider(call).buildBriefWithCost('SUV bleu', { vehicle_asset_id: 'asset-1' }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ completedRequests: 2, reportedCostUsd: 0.03 });
  });

  it('marks a rejected request as uncompleted so its budget reservation can be released', async () => {
    const call = vi.fn().mockRejectedValue(new Error('Network error'));
    const error = await createFalLlmProvider(call).buildBriefWithCost('SUV bleu', { vehicle_asset_id: 'asset-1' }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ completedRequests: 0, reportedCostUsd: null });
  });
});
