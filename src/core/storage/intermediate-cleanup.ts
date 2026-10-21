export type CompletedVersionStorage = {
  id: string;
  status: string;
  final_path: string | null;
  raw_path: string | null;
};

export type CompletedShotStorage = {
  version_id: string;
  status: string;
  raw_path: string | null;
  video_quality_previous_path?: string | null;
};

export type IntermediateVideoPath = { versionId: string; path: string };

export function collectVideoArtifactPaths(
  versions: Array<{ raw_path: string | null; final_path: string | null }>,
  shots: Array<{ raw_path: string | null; keyframe_path: string | null; video_quality_previous_path: string | null }>,
) {
  return [...new Set([
    ...versions.flatMap((version) => [version.raw_path, version.final_path]),
    ...shots.flatMap((shot) => [shot.raw_path, shot.keyframe_path, shot.video_quality_previous_path]),
  ].filter((path): path is string => Boolean(path)))];
}

/** Returns only raw clips whose final render is already available. Keyframes and finals are preserved. */
export function collectCompletedIntermediatePaths(
  versions: CompletedVersionStorage[],
  shots: CompletedShotStorage[],
): IntermediateVideoPath[] {
  const completedVersions = new Map(
    versions
      .filter((version) => version.status === 'ready' && Boolean(version.final_path))
      .map((version) => [version.id, version.final_path!] as const),
  );
  const paths = new Map<string, IntermediateVideoPath>();
  const add = (versionId: string, path: string | null | undefined) => {
    const finalPath = completedVersions.get(versionId);
    if (!finalPath || !path || path === finalPath || path.startsWith('r2://')) return;
    paths.set(`${versionId}:${path}`, { versionId, path });
  };

  for (const version of versions) {
    if (completedVersions.has(version.id)) add(version.id, version.raw_path);
  }
  for (const shot of shots) {
    if (shot.status !== 'ready' || !completedVersions.has(shot.version_id)) continue;
    add(shot.version_id, shot.raw_path);
    add(shot.version_id, shot.video_quality_previous_path);
  }

  return [...paths.values()];
}
