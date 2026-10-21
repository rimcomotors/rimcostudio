export type PreviewableVersion = {
  id: string;
  previewUrl?: string | null;
  previewSource?: string | null;
  videoUrl?: string | null;
};

export function preservePreviewUrl<T extends PreviewableVersion>(
  incoming: T,
  previous?: PreviewableVersion,
  renewPreviewIds: ReadonlySet<string> = new Set(),
): T {
  if (!Object.hasOwn(incoming, 'previewUrl')) {
    return {
      ...incoming,
      ...(previous?.previewUrl ? { previewUrl: previous.previewUrl, previewSource: previous.previewSource } : {}),
      ...(previous?.videoUrl && !Object.hasOwn(incoming, 'videoUrl') ? { videoUrl: previous.videoUrl } : {}),
    } as T;
  }
  if (!previous?.previewUrl || previous.previewSource !== incoming.previewSource || renewPreviewIds.has(incoming.id)) {
    return incoming;
  }

  return { ...incoming, previewUrl: previous.previewUrl };
}
