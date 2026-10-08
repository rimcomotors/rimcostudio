import { describe, expect, it, vi } from 'vitest';
import { buildFalLlmInput, createFalLlmProvider } from './fal-llm';

const generated = {
  location: 'Abidjan', setting: 'architecture contemporaine', character: 'conductrice naturelle',
  lighting: 'lumière douce de fin de journée', camera_movement: 'travelling latéral lent', mood: 'assurance premium', format: '9:16', creative_direction: 'Un travelling fluide révèle la voiture dans une lumière de fin de journée.',
};

describe('fal LLM brief adapter', () => {
  it('enables required reasoning and bounds generation tokens for fal OpenRouter', () => {
    expect(buildFalLlmInput('brief', 'system', 'anthropic/claude-sonnet-5.5')).toEqual({
      prompt: 'brief',
      system_prompt: 'system',
      model: 'anthropic/claude-sonnet-5.5',
      reasoning: true,
      temperature: 0.2,
      max_tokens: 1200,
    });
  });

  it('builds a validated structured brief and anchors vehicle identity and duration server-side', async () => {
    const call = vi.fn().mockResolvedValue({ output: JSON.stringify(generated) });
    const brief = await createFalLlmProvider(call).buildBrief('Une Haval H6 dans Abidjan', { vehicle_asset_id: 'asset-42', format: '16:9' });
    expect(brief).toMatchObject({ ...generated, vehicle_asset_id: 'asset-42', vehicle_description: 'Une Haval H6 dans Abidjan', format: '16:9', duration_s: 5, vehicle_category: 'autre' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toContain('Demande: Une Haval H6 dans Abidjan');
  });

  it('retries once when JSON fails schema validation, then returns a useful error if still invalid', async () => {
    const call = vi.fn().mockResolvedValueOnce({ output: '{"format":"square"}' }).mockResolvedValueOnce({ output: '{"format":"square"}' });
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
