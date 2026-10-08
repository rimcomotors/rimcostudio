import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSubmit, mockStatus, mockResult } = vi.hoisted(() => ({ mockSubmit: vi.fn(), mockStatus: vi.fn(), mockResult: vi.fn() }));
vi.mock('@fal-ai/client', () => ({ createFalClient: vi.fn(() => ({ queue: { submit: mockSubmit, status: mockStatus, result: mockResult } })) }));

describe('Veo 3.1 Fast fal adapter', () => {
  beforeEach(() => { vi.resetModules(); vi.stubEnv('FAL_KEY', 'test-fal-key'); mockSubmit.mockReset(); mockStatus.mockReset(); mockResult.mockReset(); });

  it('submits a silent six-second source with a documented ratio for five-second final trimming', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'request-veo' });
    const { veoVideoProvider, VEO_ENDPOINT } = await import('./fal-veo');
    const response = await veoVideoProvider.submit({ prompt: 'Automotive film', imageUrl: 'https://assets.example/car.jpg', durationS: 6, format: '16:9' });
    expect(response.requestId).toBe('request-veo');
    expect(mockSubmit).toHaveBeenCalledWith(VEO_ENDPOINT, { input: {
      prompt: 'Automotive film', image_url: 'https://assets.example/car.jpg', aspect_ratio: '16:9',
      duration: '6s', resolution: '720p', generate_audio: false,
    } });
  });

  it('rejects a five-second reservation rather than submitting an underfunded six-second request', async () => {
    const { veoVideoProvider } = await import('./fal-veo');
    await expect(veoVideoProvider.submit({ prompt: 'Automotive film', imageUrl: 'https://assets.example/car.jpg', durationS: 5, format: '16:9' })).rejects.toThrow('six secondes source');
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('reads the video URL from the fal client result data envelope', async () => {
    mockStatus.mockResolvedValue({ status: 'COMPLETED' });
    mockResult.mockResolvedValue({ data: { video: { url: 'https://storage.googleapis.com/fal/output.mp4' } }, requestId: 'request-veo' });
    const { veoVideoProvider } = await import('./fal-veo');
    await expect(veoVideoProvider.status('request-veo')).resolves.toEqual({ status: 'ready', videoUrl: 'https://storage.googleapis.com/fal/output.mp4' });
  });
});
