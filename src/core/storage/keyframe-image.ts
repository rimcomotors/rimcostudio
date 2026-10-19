export type KeyframeImageContentType = 'image/jpeg' | 'image/png' | 'image/webp';

const extensionByContentType: Record<KeyframeImageContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function keyframeImageUploadTarget(input: {
  videoId: string;
  versionId: string;
  shotNumber: number;
  contentType: string;
}) {
  const extension = extensionByContentType[input.contentType as KeyframeImageContentType];
  if (!extension) throw new Error('Format d’image-clé non pris en charge.');
  if (!Number.isInteger(input.shotNumber) || input.shotNumber < 1) throw new Error('Numéro de plan invalide.');
  if (![input.videoId, input.versionId].every((id) => /^[\w-]+$/.test(id))) throw new Error('Identifiant de stockage invalide.');

  return {
    bucket: 'videos' as const,
    path: `${input.videoId}/${input.versionId}/keyframe-${input.shotNumber}.${extension}`,
    options: { contentType: input.contentType, upsert: true as const },
  };
}
