import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSubmit, mockStatus, mockResult, mockCreate } = vi.hoisted(() => ({ mockSubmit: vi.fn(), mockStatus: vi.fn(), mockResult: vi.fn(), mockCreate: vi.fn() }));
vi.mock('@fal-ai/client', () => ({ createFalClient: (...args: unknown[]) => { mockCreate(...args); return { queue: { submit: mockSubmit, status: mockStatus, result: mockResult } }; } }));

describe('Wan 3.0 fal adapter', () => {
  beforeEach(() => { vi.resetModules(); vi.stubEnv('FAL_KEY', 'test-fal-key'); mockSubmit.mockReset(); mockStatus.mockReset(); mockResult.mockReset(); mockCreate.mockReset(); });

  it('submits a silent, single-shot five-second video with the selected ratio at 720p', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'request-456' });
    const { wanVideoProvider, WAN_ENDPOINT } = await import('./fal-wan');
    const response = await wanVideoProvider.submit({ prompt: 'Automotive film', imageUrl: 'https://assets.example/car.jpg', durationS: 5, format: '9:16' });
    expect(response.requestId).toBe('request-456');
    expect(mockSubmit).toHaveBeenCalledWith(WAN_ENDPOINT, { input: {
      prompt: 'Automotive film', start_image_url: 'https://assets.example/car.jpg', duration: 5,
      aspect_ratio: '9:16', resolution: '720p', audio: false, enable_prompt_expansion: false, enable_safety_checker: true,
    } });
  });

  it('returns status and the completed video URL', async () => {
    mockStatus.mockResolvedValue({ status: 'COMPLETED' });
    mockResult.mockResolvedValue({ data: { video: { url: 'https://v3.fal.media/output.mp4' } }, requestId: 'request-456' });
    const { wanVideoProvider } = await import('./fal-wan');
    expect(await wanVideoProvider.status('request-456')).toEqual({ status: 'ready', videoUrl: 'https://v3.fal.media/output.mp4' });
  });

  it('uses the credential pinned to a generation for submit and status', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'request-pinned' });
    mockStatus.mockResolvedValue({ status: 'IN_QUEUE' });
    const { wanVideoProvider } = await import('./fal-wan');
    await wanVideoProvider.submit({ prompt: 'Automotive film', imageUrl: 'https://assets.example/car.jpg', durationS: 5, format: '16:9' }, 'fal-version-key');
    await wanVideoProvider.status('request-pinned', 'fal-version-key');
    expect(mockCreate).toHaveBeenNthCalledWith(1, { credentials: 'fal-version-key' });
    expect(mockCreate).toHaveBeenNthCalledWith(2, { credentials: 'fal-version-key' });
  });
});
