import { beforeEach, describe, expect, it, vi } from 'vitest';
const { mockSubmit, mockStatus, mockResult } = vi.hoisted(() => ({ mockSubmit: vi.fn(), mockStatus: vi.fn(), mockResult: vi.fn() }));
vi.mock('@fal-ai/client', () => ({ createFalClient: vi.fn(() => ({ queue: { submit: mockSubmit, status: mockStatus, result: mockResult } })) }));

describe('Kling fal adapter', () => {
  beforeEach(() => { vi.resetModules(); vi.stubEnv('FAL_KEY', 'test-fal-key'); mockSubmit.mockReset(); mockStatus.mockReset(); mockResult.mockReset(); });
  it('submits only verified Kling image-to-video fields with audio disabled and fixed five seconds', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'request-123' });
    const { klingVideoProvider, KLING_ENDPOINT } = await import('./fal-kling');
    const response = await klingVideoProvider.submit({ prompt: 'A vehicle commercial', imageUrl: 'https://assets.example/car.jpg', durationS: 5, format: '16:9' });
    expect(response.requestId).toBe('request-123');
    expect(mockSubmit).toHaveBeenCalledWith(KLING_ENDPOINT, { input: { prompt: 'A vehicle commercial', image_url: 'https://assets.example/car.jpg', duration: '5', generate_audio: false } });
  });

  it('supports a three-second source clip for the short two-shot prototype', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'short-shot-request' });
    const { klingVideoProvider, KLING_ENDPOINT } = await import('./fal-kling');
    await klingVideoProvider.submit({ prompt: 'Establish the vehicle', imageUrl: 'https://assets.example/car.jpg', durationS: 3, format: '16:9' });
    expect(mockSubmit).toHaveBeenCalledWith(KLING_ENDPOINT, { input: expect.objectContaining({ duration: '3', generate_audio: false }) });
  });
  it('maps queued and completed responses and returns the provider video URL', async () => {
    mockStatus.mockResolvedValue({ status: 'IN_QUEUE' });
    const { klingVideoProvider } = await import('./fal-kling');
    expect(await klingVideoProvider.status('request-123')).toEqual({ status: 'queued' });
    mockStatus.mockResolvedValue({ status: 'COMPLETED' });
    mockResult.mockResolvedValue({ data: { video: { url: 'https://v3.fal.media/output.mp4' } }, requestId: 'request-123' });
    expect(await klingVideoProvider.status('request-123')).toEqual({ status: 'ready', videoUrl: 'https://v3.fal.media/output.mp4' });
  });
});
