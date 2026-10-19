import { describe, expect, it } from 'vitest';
import { requestSchema } from './request-schema';

describe('requestSchema logo setting', () => {
  it('defaults logo compositing to enabled', () => {
    expect(requestSchema.parse({ assetId: 'vehicle-1' }).overlayLogo).toBe(true);
  });

  it('accepts disabling the logo for one video', () => {
    expect(requestSchema.parse({ assetId: 'vehicle-1', overlayLogo: false }).overlayLogo).toBe(false);
  });

  it('accepts the full creative direction length allowed by the Studio field', () => {
    expect(requestSchema.parse({ assetId: 'vehicle-1', description: 'a'.repeat(1000) }).description).toHaveLength(1000);
  });

  it('rejects creative directions longer than the Studio field limit', () => {
    expect(() => requestSchema.parse({ assetId: 'vehicle-1', description: 'a'.repeat(1001) })).toThrow();
  });
});
