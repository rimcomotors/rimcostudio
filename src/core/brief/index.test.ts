import { describe, expect, it } from 'vitest';
import { briefToPrompt, buildBrief } from './index';

describe('brief', () => {
  it('builds a five second image-to-video brief with validated options', () => {
    const brief = buildBrief('Haval H6 bleu nuit', { vehicle_asset_id: 'asset-1', format: '9:16' });
    expect(brief.duration_s).toBe(5);
    expect(brief.vehicle_asset_id).toBe('asset-1');
    expect(brief.format).toBe('9:16');
  });
  it('rejects an empty description', () => expect(() => buildBrief('', { vehicle_asset_id: 'asset-1' })).toThrow());
  it('accepts the full 1,000-character user direction supported by Studio', () => {
    const direction = 'a'.repeat(1000);
    expect(buildBrief('Tank 300 gris', { vehicle_asset_id: 'asset-1', user_direction: direction }).user_direction).toBe(direction);
    expect(() => buildBrief('Tank 300 gris', { vehicle_asset_id: 'asset-1', user_direction: `${direction}a` })).toThrow();
  });
  it('creates an English prompt preserving the reference vehicle identity', () => {
    const prompt = briefToPrompt(buildBrief('Haval H6 bleu nuit', { vehicle_asset_id: 'asset-1' }), 'kling');
    expect(prompt).toContain('image-to-video');
    expect(prompt).toContain('Do not alter the vehicle identity');
  });
});
