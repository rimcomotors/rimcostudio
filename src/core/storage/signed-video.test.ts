import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSignedUrlCache, createSignedStoragePreviewUrl, createSignedVideoDownloadUrl } from './signed-video';

beforeEach(() => clearSignedUrlCache());

describe('createSignedVideoDownloadUrl', () => {
  it('requests a signed URL with download disposition', async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.example/video.mp4?download=' }, error: null });

    await expect(createSignedVideoDownloadUrl(createSignedUrl, 'video-id/version-id/final.mp4')).resolves.toBe('https://storage.example/video.mp4?download=');
    expect(createSignedUrl).toHaveBeenCalledWith('video-id/version-id/final.mp4', 3600, { download: true });
  });

  it('returns null when Storage does not provide a signed link', async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: null, error: new Error('Storage unavailable') });

    await expect(createSignedVideoDownloadUrl(createSignedUrl, 'video-id/version-id/final.mp4')).resolves.toBeNull();
  });

  it('reuses an unexpired URL instead of creating a new token for the same object', async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.example/video.mp4?token=stable' }, error: null });

    const first = await createSignedVideoDownloadUrl(createSignedUrl, 'video-id/version-id/final.mp4');
    const second = await createSignedVideoDownloadUrl(createSignedUrl, 'video-id/version-id/final.mp4');

    expect(first).toBe('https://storage.example/video.mp4?token=stable');
    expect(second).toBe(first);
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('keeps preview and attachment URLs separate because their response headers differ', async () => {
    const createSignedUrl = vi.fn()
      .mockResolvedValueOnce({ data: { signedUrl: 'https://storage.example/video.mp4?token=preview' }, error: null })
      .mockResolvedValueOnce({ data: { signedUrl: 'https://storage.example/video.mp4?token=download' }, error: null });
    const path = 'video-id/version-id/final.mp4';

    await expect(createSignedStoragePreviewUrl(createSignedUrl, 'videos', path)).resolves.toContain('token=preview');
    await expect(createSignedVideoDownloadUrl(createSignedUrl, path)).resolves.toContain('token=download');
    expect(createSignedUrl).toHaveBeenCalledTimes(2);
    expect(createSignedUrl).toHaveBeenNthCalledWith(1, path, 3600);
    expect(createSignedUrl).toHaveBeenNthCalledWith(2, path, 3600, { download: true });
  });

  it('does not reuse a URL once it approaches its expiry', async () => {
    vi.useFakeTimers();
    try {
      const createSignedUrl = vi.fn()
        .mockResolvedValueOnce({ data: { signedUrl: 'https://storage.example/video.mp4?token=old' }, error: null })
        .mockResolvedValueOnce({ data: { signedUrl: 'https://storage.example/video.mp4?token=new' }, error: null });

      await createSignedVideoDownloadUrl(createSignedUrl, 'video-id/version-id/final.mp4');
      vi.advanceTimersByTime(51 * 60 * 1000);
      await expect(createSignedVideoDownloadUrl(createSignedUrl, 'video-id/version-id/final.mp4')).resolves.toContain('token=new');
      expect(createSignedUrl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
