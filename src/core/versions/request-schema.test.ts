import { describe, expect, it } from 'vitest';
import { requestSchema } from './request-schema';

describe('requestSchema logo setting', () => {
  it('defaults logo compositing to enabled', () => {
    expect(requestSchema.parse({ assetId: 'vehicle-1' }).overlayLogo).toBe(true);
  });

  it('accepts disabling the logo for one video', () => {
    expect(requestSchema.parse({ assetId: 'vehicle-1', overlayLogo: false }).overlayLogo).toBe(false);
  });
});
