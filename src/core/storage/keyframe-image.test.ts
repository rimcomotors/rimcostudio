import { describe, expect, it } from 'vitest';
import { keyframeImageUploadTarget } from './keyframe-image';

describe('keyframe image storage target', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
  ])('stores %s in the private video bucket with the matching extension', (contentType, extension) => {
    expect(keyframeImageUploadTarget({
      videoId: 'video-1', versionId: 'version-2', shotNumber: 1, contentType,
    })).toEqual({
      bucket: 'videos',
      path: `video-1/version-2/keyframe-1.${extension}`,
      options: { contentType, upsert: true },
    });
  });

  it('rejects an image content type that the private bucket does not allow', () => {
    expect(() => keyframeImageUploadTarget({
      videoId: 'video-1', versionId: 'version-2', shotNumber: 1, contentType: 'image/avif',
    })).toThrow('Format d’image-clé non pris en charge.');
  });

  it('rejects an invalid shot number', () => {
    expect(() => keyframeImageUploadTarget({
      videoId: 'video-1', versionId: 'version-2', shotNumber: 0, contentType: 'image/png',
    })).toThrow('Numéro de plan invalide.');
  });
});
