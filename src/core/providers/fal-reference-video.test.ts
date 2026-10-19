import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSubmit, mockStatus, mockResult } = vi.hoisted(() => ({ mockSubmit: vi.fn(), mockStatus: vi.fn(), mockResult: vi.fn() }));
vi.mock('@fal-ai/client', () => ({ createFalClient: vi.fn(() => ({ queue: { submit: mockSubmit, status: mockStatus, result: mockResult } })) }));

const input = { prompt: 'A premium vehicle film', referenceImageUrls: ['https://assets.example/car.jpg', 'https://assets.example/plateau.jpg'], durationS: 5, aspectRatio: '16:9' };

describe('fal Reference-to-Video adapters', () => {
  beforeEach(() => { vi.resetModules(); vi.stubEnv('FAL_KEY', 'test-fal-key'); mockSubmit.mockReset(); mockStatus.mockReset(); mockResult.mockReset(); });

  it('submits Wan 2.7 with its documented reference fields and numeric duration', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'wan-request' });
    const { wanReferenceVideoProvider, WAN_REFERENCE_ENDPOINT } = await import('./fal-reference-video');
    await wanReferenceVideoProvider.submit(input);
    expect(mockSubmit).toHaveBeenCalledWith(WAN_REFERENCE_ENDPOINT, { input: {
      prompt: expect.stringContaining('@Image1, @Image2'), reference_image_urls: input.referenceImageUrls,
      duration: 5, aspect_ratio: '16:9', resolution: '1080p', multi_shots: false, enable_safety_checker: true,
    } });
  });

  it('submits Kling O3 with documented image_urls, string duration, and audio disabled', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'kling-request' });
    const { klingReferenceVideoProvider, KLING_REFERENCE_ENDPOINT } = await import('./fal-reference-video');
    await klingReferenceVideoProvider.submit(input);
    expect(mockSubmit).toHaveBeenCalledWith(KLING_REFERENCE_ENDPOINT, { input: {
      prompt: expect.stringContaining('@Image1, @Image2'), image_urls: input.referenceImageUrls,
      duration: '5', aspect_ratio: '16:9', generate_audio: false,
    } });
  });

  it('submits Seedance reference task with multiple images and required end-user ID', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'seedance-request' });
    const { seedanceReferenceVideoProvider, SEEDANCE_REFERENCE_ENDPOINT } = await import('./fal-reference-video');
    await seedanceReferenceVideoProvider.submit({ ...input, endUserId: 'user-1' });
    expect(mockSubmit).toHaveBeenCalledWith(SEEDANCE_REFERENCE_ENDPOINT, { input: {
      prompt: expect.stringContaining('@Image1, @Image2'), image_urls: input.referenceImageUrls,
      duration: '5', aspect_ratio: '16:9', resolution: '720p', generate_audio: false, end_user_id: 'user-1',
    } });
  });

  it('passes the selected square ratio to all three reference endpoints', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'aspect-request' });
    const { wanReferenceVideoProvider, klingReferenceVideoProvider, seedanceReferenceVideoProvider } = await import('./fal-reference-video');
    const squareInput = { ...input, aspectRatio: '1:1' as const, endUserId: 'user-1' };
    await wanReferenceVideoProvider.submit(squareInput);
    expect(mockSubmit.mock.calls.at(-1)?.[1]).toMatchObject({ input: { aspect_ratio: '1:1' } });
    await klingReferenceVideoProvider.submit(squareInput);
    expect(mockSubmit.mock.calls.at(-1)?.[1]).toMatchObject({ input: { aspect_ratio: '1:1' } });
    await seedanceReferenceVideoProvider.submit(squareInput);
    expect(mockSubmit.mock.calls.at(-1)?.[1]).toMatchObject({ input: { aspect_ratio: '1:1' } });
  });

  it('keeps useful provider error details while masking URLs and credential-like values', async () => {
    const { safeProviderError } = await import('./fal-reference-video');
    expect(safeProviderError(new Error('Invalid reference https://assets.example/private.jpg bearer: secret-token')))
      .toBe('Invalid reference [URL masquée] bearer=[masqué]');
    expect(safeProviderError(new Error('Invalid prompt: unsupported camera movement')))
      .toBe('Invalid prompt: unsupported camera movement');
  });

  it('rejects unsupported clip lengths, ratios, and too many Kling reference images before queue submission', async () => {
    const { klingReferenceVideoProvider } = await import('./fal-reference-video');
    await expect(klingReferenceVideoProvider.submit({ ...input, durationS: 16 })).rejects.toThrow('entre 3 et 15');
    await expect(klingReferenceVideoProvider.submit({ ...input, aspectRatio: '4:5' })).rejects.toThrow('Format vidéo non pris en charge');
    await expect(klingReferenceVideoProvider.submit({ ...input, referenceImageUrls: Array(5).fill('https://assets.example/ref.jpg') })).rejects.toThrow('1 à 4');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('normalizes queue status and returns a completed video URL', async () => {
    mockStatus.mockResolvedValue({ status: 'COMPLETED' });
    mockResult.mockResolvedValue({ data: { video: { url: 'https://v3.fal.media/result.mp4' } }, requestId: 'request' });
    const { wanReferenceVideoProvider } = await import('./fal-reference-video');
    expect(await wanReferenceVideoProvider.status('request')).toEqual({ status: 'ready', videoUrl: 'https://v3.fal.media/result.mp4' });
  });

  it('uses the endpoint persisted with an existing provider request for both status and result', async () => {
    mockStatus.mockResolvedValue({ status: 'COMPLETED' });
    mockResult.mockResolvedValue({ data: { video: { url: 'https://v3.fal.media/saved-endpoint.mp4' } }, requestId: 'request' });
    const { klingReferenceVideoProvider } = await import('./fal-reference-video');
    const savedEndpoint = 'fal-ai/kling-video/o3/pro/reference-to-video-v2';
    await expect(klingReferenceVideoProvider.status('request', 'test-fal-key', savedEndpoint)).resolves.toEqual({
      status: 'ready', videoUrl: 'https://v3.fal.media/saved-endpoint.mp4',
    });
    expect(mockStatus).toHaveBeenCalledWith(savedEndpoint, { requestId: 'request', logs: false });
    expect(mockResult).toHaveBeenCalledWith(savedEndpoint, { requestId: 'request' });
  });
});
