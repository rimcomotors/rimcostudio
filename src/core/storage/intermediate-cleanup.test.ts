import { describe, expect, it } from 'vitest';
import { collectCompletedIntermediatePaths, collectVideoArtifactPaths } from './intermediate-cleanup';

describe('collectCompletedIntermediatePaths', () => {
  it('selects only raw clips belonging to ready versions with a final and never the final itself', () => {
    const versions = [
      { id: 'ready', status: 'ready', final_path: 'v1/final.mp4', raw_path: 'v1/raw.mp4' },
      { id: 'pending', status: 'postprocessing', final_path: null, raw_path: 'v2/raw.mp4' },
      { id: 'missing-final', status: 'ready', final_path: null, raw_path: 'v3/raw.mp4' },
      { id: 'same-path', status: 'ready', final_path: 'v4/raw.mp4', raw_path: 'v4/raw.mp4' },
    ];
    const shots = [
      { version_id: 'ready', status: 'ready', raw_path: 'v1/shot-1.mp4', video_quality_previous_path: 'v1/shot-1-retry-old.mp4' },
      { version_id: 'ready', status: 'failed', raw_path: 'v1/failed.mp4' },
      { version_id: 'pending', status: 'ready', raw_path: 'v2/shot-1.mp4' },
    ];

    expect(collectCompletedIntermediatePaths(versions, shots)).toEqual([
      { versionId: 'ready', path: 'v1/raw.mp4' },
      { versionId: 'ready', path: 'v1/shot-1.mp4' },
      { versionId: 'ready', path: 'v1/shot-1-retry-old.mp4' },
    ]);
  });

  it('deduplicates paths and excludes empty or final references', () => {
    const versions = [{ id: 'ready', status: 'ready', final_path: 'v/final.mp4', raw_path: 'v/raw.mp4' }];
    const shots = [
      { version_id: 'ready', status: 'ready', raw_path: 'v/raw.mp4' },
      { version_id: 'ready', status: 'ready', raw_path: 'v/final.mp4', video_quality_previous_path: 'r2://old/retry.mp4' },
      { version_id: 'ready', status: 'ready', raw_path: null },
    ];

    expect(collectCompletedIntermediatePaths(versions, shots)).toEqual([
      { versionId: 'ready', path: 'v/raw.mp4' },
    ]);
  });
});

describe('collectVideoArtifactPaths', () => {
  it('includes every video, shot and keyframe object when a user deletes a video', () => {
    expect(collectVideoArtifactPaths(
      [{ raw_path: 'v/raw.mp4', final_path: 'v/final.mp4' }],
      [{ raw_path: 'v/shot.mp4', keyframe_path: 'v/keyframe.png', video_quality_previous_path: 'v/old-shot.mp4' }],
    )).toEqual(['v/raw.mp4', 'v/final.mp4', 'v/shot.mp4', 'v/keyframe.png', 'v/old-shot.mp4']);
  });

  it('removes null paths and duplicate object keys', () => {
    expect(collectVideoArtifactPaths(
      [{ raw_path: null, final_path: 'v/final.mp4' }],
      [{ raw_path: 'v/final.mp4', keyframe_path: null, video_quality_previous_path: null }],
    )).toEqual(['v/final.mp4']);
  });
});
