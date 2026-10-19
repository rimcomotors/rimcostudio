import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildKeyframeAnimationPrompt, buildKeyframePrompt, canAnimateKeyframes, keyframeQualityAction, parseKeyframeQuality, shouldGenerateKeyframes } from './fal-keyframes';

const { mockSubmit, mockStatus, mockResult } = vi.hoisted(() => ({ mockSubmit: vi.fn(), mockStatus: vi.fn(), mockResult: vi.fn() }));
vi.mock('@fal-ai/client', () => ({ createFalClient: vi.fn(() => ({ queue: { submit: mockSubmit, status: mockStatus, result: mockResult } })) }));

describe('fal keyframe helpers', () => {
  beforeEach(() => { vi.resetModules(); vi.stubEnv('FAL_KEY', 'test-fal-key'); mockSubmit.mockReset(); mockStatus.mockReset(); mockResult.mockReset(); });
  it('creates a still-image direction from the approved shot without asking for motion', () => {
    const prompt = buildKeyframePrompt({
      shot: { title: 'Départ en famille', scene: 'Boulevard lagunaire', framing: 'Plan large', location: 'Abidjan', action: 'La famille prend place', camera: 'Contre-plongée discrète', durationSeconds: 5, vehiclePhotoId: 'vehicle-1', locationPhotoId: 'place-1' },
      vehicle: 'Haval H9 noir', lighting: 'fin de journée', format: '16:9', retryReason: null,
    });
    expect(prompt).toContain('Haval H9 noir');
    expect(prompt).toContain('Boulevard lagunaire');
    expect(prompt).toContain('Plan large');
    expect(prompt).toContain('still photograph');
    expect(prompt).toContain('do not add text');
  });

  it('accepts only explicit valid JSON quality decisions', () => {
    expect(parseKeyframeQuality('{"approved":true,"issues":[],"reason":"Conforme"}')).toEqual({ approved: true, issues: [], reason: 'Conforme' });
    expect(parseKeyframeQuality('```json\n{"approved":false,"issues":["couleur différente"],"reason":"Véhicule incorrect"}\n```')?.approved).toBe(false);
    expect(parseKeyframeQuality('yes')).toBeNull();
    expect(parseKeyframeQuality('{"approved":"yes","issues":[],"reason":"x"}')).toBeNull();
  });

  it('requires reasoning for the fal vision check endpoint', async () => {
    vi.stubEnv('LLM_MODEL', 'anthropic/claude-sonnet-5.5');
    mockSubmit.mockResolvedValue({ request_id: 'vision-check-1' });
    const { submitKeyframeQuality, KEYFRAME_VISION_ENDPOINT } = await import('./fal-keyframes');

    await submitKeyframeQuality({ prompt: 'Vérifie le véhicule et le lieu.', imageUrls: ['https://assets.example/keyframe.png'] }, 'test-fal-key');

    expect(mockSubmit).toHaveBeenCalledWith(KEYFRAME_VISION_ENDPOINT, { input: expect.objectContaining({
      model: 'anthropic/claude-sonnet-5.5',
      reasoning: true,
      image_urls: ['https://assets.example/keyframe.png'],
    }) });
  });

  it('animates the generated image as the opening frame while preserving motion direction', () => {
    const prompt = buildKeyframeAnimationPrompt({
      shot: { title: 'Départ', scene: 'Boulevard lagunaire', framing: 'Plan large', location: 'Abidjan', action: 'Le véhicule démarre doucement', camera: 'Travelling latéral', durationSeconds: 5, vehiclePhotoId: 'vehicle-1', locationPhotoId: 'place-1' },
      vehicle: 'Haval H9 noir', durationS: 5, mood: 'élégant', lighting: 'fin de journée',
    });
    expect(prompt).toContain('exact first frame');
    expect(prompt).toContain('démarre doucement');
    expect(prompt).toContain('no cuts');
  });

  it('creates automatic keyframes for all tiers', () => {
    expect(shouldGenerateKeyframes('standard')).toBe(true);
    expect(shouldGenerateKeyframes('pro')).toBe(true);
    expect(shouldGenerateKeyframes('premium')).toBe(true);
  });

  it('allows only one automatic quality retry and blocks animation until every keyframe passes', () => {
    expect(keyframeQualityAction(true, 0)).toBe('accept');
    expect(keyframeQualityAction(false, 0)).toBe('retry');
    expect(keyframeQualityAction(false, 1)).toBe('reject');
    expect(canAnimateKeyframes(['ready', 'checking'])).toBe(false);
    expect(canAnimateKeyframes(['ready', 'ready'])).toBe(true);
    expect(canAnimateKeyframes([])).toBe(false);
  });

  it('animates Standard keyframes through Wan 3.0 using the accepted image as its first frame', async () => {
    mockSubmit.mockResolvedValue({ request_id: 'wan-keyframe-video' });
    const { keyframeVideoProviders, KEYFRAME_VIDEO_ENDPOINTS } = await import('./fal-keyframes');
    await keyframeVideoProviders.wan.submit({
      prompt: 'Slow cinematic vehicle movement', referenceImageUrls: ['https://assets.example/keyframe.png'],
      durationS: 5, aspectRatio: '9:16',
    }, 'test-fal-key');
    expect(mockSubmit).toHaveBeenCalledWith(KEYFRAME_VIDEO_ENDPOINTS.wan, { input: {
      prompt: 'Slow cinematic vehicle movement', start_image_url: 'https://assets.example/keyframe.png', duration: 5,
      aspect_ratio: '9:16', resolution: '720p', audio: false, enable_prompt_expansion: false, enable_safety_checker: true,
    } });
  });

  it('rejects Wan keyframe formats and durations outside its verified capabilities before charging', async () => {
    const { keyframeVideoProviders } = await import('./fal-keyframes');
    const input = { prompt: 'Motion', referenceImageUrls: ['https://assets.example/keyframe.png'], durationS: 5, aspectRatio: '4:5' };
    await expect(keyframeVideoProviders.wan.submit(input, 'test-fal-key')).rejects.toThrow('Format vidéo non pris en charge');
    await expect(keyframeVideoProviders.wan.submit({ ...input, aspectRatio: '16:9', durationS: 10 }, 'test-fal-key')).rejects.toThrow('exige des segments de 5 secondes');
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
