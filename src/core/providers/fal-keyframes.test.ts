import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildKeyframeAnimationPrompt, buildKeyframePrompt, buildKeyframeQualityPrompt, canAnimateKeyframes, extractFalVisionResult, keyframeQualityAction, parseKeyframeQuality, selectKeyframeReferenceIds, shouldGenerateKeyframes } from './fal-keyframes';

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

  it('labels the base photo, supplemental views, and location separately in the keyframe prompt', () => {
    const prompt = buildKeyframePrompt({
      shot: { title: 'Plan héros', scene: 'Route rouge', framing: 'Trois-quarts avant', location: 'Abidjan', action: 'Le véhicule roule', camera: 'Travelling stable', durationSeconds: 5, vehiclePhotoId: 'front', locationPhotoId: 'place' },
      vehicle: 'GWM Tank 300 gris', lighting: 'fin de journée', format: '16:9', retryReason: null,
      vehicleReferenceCount: 3, hasLocationReference: true,
    });
    expect(prompt).toContain('first supplied image is the exact approved vehicle base photo');
    expect(prompt).toContain('next 2 images are additional views of the same exact vehicle');
    expect(prompt).toContain('final supplied image is the exact selected location');
  });

  it('selects the base view first, diverse approved vehicle angles next, and the location last', () => {
    expect(selectKeyframeReferenceIds({
      primaryVehiclePhotoId: 'front-main',
      vehiclePhotos: [
        { id: 'front-main', angle: 'Avant trois-quarts', photo_role: 'exterior' },
        { id: 'front-alt', angle: 'Avant trois-quarts', photo_role: 'exterior' },
        { id: 'rear', angle: 'Arrière trois-quarts', photo_role: 'exterior' },
        { id: 'profile', angle: 'Profil', photo_role: 'exterior' },
      ],
      locationPhotoId: 'hkb',
    })).toEqual(['front-main', 'rear', 'profile', 'front-alt', 'hkb']);
  });

  it('keeps at most 14 references and reserves the final slot for the selected place', () => {
    const vehiclePhotos = Array.from({ length: 20 }, (_, index) => ({
      id: `view-${index}`,
      angle: `angle-${index}`,
      photo_role: 'exterior',
    }));
    const result = selectKeyframeReferenceIds({ primaryVehiclePhotoId: 'view-0', vehiclePhotos, locationPhotoId: 'place' });
    expect(result).toHaveLength(14);
    expect(result[0]).toBe('view-0');
    expect(result.at(-1)).toBe('place');
    expect(new Set(result).size).toBe(14);
  });

  it('describes dynamic reference roles when the quality model checks the candidate', () => {
    const prompt = buildKeyframeQualityPrompt({ vehicleReferenceCount: 3, hasLocationReference: true });
    expect(prompt).toContain('image 1 = candidate keyframe');
    expect(prompt).toContain('images 2 to 4 = approved views of the same exact vehicle');
    expect(prompt).toContain('image 5 = selected location');
  });

  it('accepts only explicit valid JSON quality decisions', () => {
    expect(parseKeyframeQuality('{"approved":true,"issues":[],"reason":"Conforme"}')).toEqual({ approved: true, issues: [], reason: 'Conforme' });
    expect(parseKeyframeQuality('```json\n{"approved":false,"issues":["couleur différente"],"reason":"Véhicule incorrect"}\n```')?.approved).toBe(false);
    expect(parseKeyframeQuality('Analyse terminée. Résultat : {"approved":true,"issues":[],"reason":"Conforme"}')).toEqual({ approved: true, issues: [], reason: 'Conforme' });
    expect(parseKeyframeQuality('yes')).toBeNull();
    expect(parseKeyframeQuality('{"approved":"yes","issues":[],"reason":"x"}')).toBeNull();
  });

  it('extracts the documented fal vision response and cost', () => {
    expect(extractFalVisionResult({ data: { output: '{"approved":true,"issues":[],"reason":"Conforme"}', usage: { cost: 0.012 } } })).toEqual({
      output: '{"approved":true,"issues":[],"reason":"Conforme"}', costUsd: 0.012,
    });
  });

  it('extracts compatible flattened and chat-style vision responses', () => {
    expect(extractFalVisionResult({ output: '```json\n{"approved":true,"issues":[],"reason":"OK"}\n```' })).toEqual({
      output: '```json\n{"approved":true,"issues":[],"reason":"OK"}\n```', costUsd: null,
    });
    expect(extractFalVisionResult({ data: { choices: [{ message: { content: '{"approved":true,"issues":[],"reason":"OK"}' } }] } })).toEqual({
      output: '{"approved":true,"issues":[],"reason":"OK"}', costUsd: null,
    });
  });

  it('uses a valid structured decision in reasoning only when the final output is empty or truncated', () => {
    const decision = '{"approved":true,"issues":[],"reason":"Conforme"}';
    expect(extractFalVisionResult({ data: { output: '', reasoning: decision } }).output).toBe(decision);
    expect(extractFalVisionResult({ data: { output: '{"approved":true,"issues":[],"reason":"Tronqué', reasoning: decision } }).output).toBe(decision);
    expect(extractFalVisionResult({ data: { output: '', reasoning: 'Un raisonnement sans décision structurée.' } }).output).toBe('');
  });

  it('serializes a structured object returned directly by a compatible vision provider', () => {
    expect(extractFalVisionResult({ data: { output: { approved: true, issues: [], reason: 'Conforme' } } }).output)
      .toBe('{"approved":true,"issues":[],"reason":"Conforme"}');
  });

  it('ignores unexpected quality metadata while requiring the complete decision fields', () => {
    expect(parseKeyframeQuality('{"approved":true,"issues":[],"reason":"Conforme","confidence":0.98}')).toEqual({
      approved: true, issues: [], reason: 'Conforme',
    });
    expect(parseKeyframeQuality('{"approved":true,"reason":"Conforme"}')).toBeNull();
  });

  it('enables the reasoning mode required by the configured fal vision model', async () => {
    vi.stubEnv('LLM_MODEL', 'anthropic/claude-sonnet-5.5');
    mockSubmit.mockResolvedValue({ request_id: 'vision-check-1' });
    const { submitKeyframeQuality, KEYFRAME_VISION_ENDPOINT } = await import('./fal-keyframes');

    await submitKeyframeQuality({ prompt: 'Vérifie le véhicule et le lieu.', imageUrls: ['https://assets.example/keyframe.png'] }, 'test-fal-key');

    expect(mockSubmit).toHaveBeenCalledWith(KEYFRAME_VISION_ENDPOINT, { input: expect.objectContaining({
      model: 'anthropic/claude-sonnet-5.5',
      reasoning: true,
      max_tokens: 1500,
      system_prompt: expect.stringContaining('objet JSON compact'),
      image_urls: ['https://assets.example/keyframe.png'],
    }) });
    expect(mockSubmit.mock.calls[0][1].input.reasoning).toBe(true);
  });

  it('polls a saved fal endpoint instead of silently switching to the current default', async () => {
    mockStatus.mockResolvedValue({ status: 'IN_PROGRESS' });
    const { readKeyframe, KEYFRAME_IMAGE_ENDPOINT } = await import('./fal-keyframes');
    await readKeyframe('saved-request', 'test-fal-key', 'fal-ai/nano-banana-2/edit-v2');
    expect(mockStatus).toHaveBeenCalledWith('fal-ai/nano-banana-2/edit-v2', { requestId: 'saved-request', logs: false });
    expect(KEYFRAME_IMAGE_ENDPOINT).not.toBe('fal-ai/nano-banana-2/edit-v2');
  });

  it('requests fal diagnostics when the vision queue fails', async () => {
    vi.stubEnv('LLM_MODEL', 'anthropic/claude-sonnet-5.5');
    mockStatus.mockResolvedValue({ status: 'FAILED', logs: [{ message: 'Provider rejected the response.' }] });
    const { readKeyframeQuality, KEYFRAME_VISION_ENDPOINT } = await import('./fal-keyframes');

    await expect(readKeyframeQuality('vision-check-failed', 'test-fal-key')).resolves.toMatchObject({
      status: 'failed', error: 'Provider rejected the response.',
    });
    expect(mockStatus).toHaveBeenCalledWith(KEYFRAME_VISION_ENDPOINT, { requestId: 'vision-check-failed', logs: true });
  });

  it('accepts the documented fal vision result and records its actual usage cost', async () => {
    vi.stubEnv('LLM_MODEL', 'anthropic/claude-sonnet-5.5');
    mockStatus.mockResolvedValue({ status: 'COMPLETED' });
    mockResult.mockResolvedValue({ data: { output: '{"approved":true,"issues":[],"reason":"Conforme"}', usage: { cost: 0.003 } } });
    const { readKeyframeQuality } = await import('./fal-keyframes');

    await expect(readKeyframeQuality('vision-check-2', 'test-fal-key')).resolves.toMatchObject({
      status: 'ready', costUsd: 0.003, quality: { approved: true, issues: [], reason: 'Conforme' },
    });
  });

  it('keeps a bounded output excerpt in server diagnostics for invalid vision results', async () => {
    vi.stubEnv('LLM_MODEL', 'anthropic/claude-sonnet-5.5');
    mockStatus.mockResolvedValue({ status: 'COMPLETED' });
    mockResult.mockResolvedValue({ data: { output: 'This is not the requested decision.' } });
    const { readKeyframeQuality } = await import('./fal-keyframes');

    await expect(readKeyframeQuality('vision-check-invalid', 'test-fal-key')).resolves.toMatchObject({
      status: 'failed', error: expect.stringContaining('This is not the requested decision.'),
    });
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
