import { describe, expect, it } from 'vitest';
import { preservePreviewUrl } from './preview-cache';

describe('preservePreviewUrl', () => {
  it('reuses the same signed preview URL while refreshing metadata', () => {
    const previous = { id: 'version-1', previewSource: 'final', previewUrl: 'https://storage.example/old-token' };
    const incoming = { id: 'version-1', previewSource: 'final', previewUrl: 'https://storage.example/new-token', status: 'generating' };

    expect(preservePreviewUrl(incoming, previous)).toEqual({ ...incoming, previewUrl: previous.previewUrl });
  });

  it('uses a fresh URL when the preview file changes', () => {
    const previous = { id: 'version-1', previewSource: 'raw', previewUrl: 'https://storage.example/raw-token' };
    const incoming = { id: 'version-1', previewSource: 'final', previewUrl: 'https://storage.example/final-token' };

    expect(preservePreviewUrl(incoming, previous)).toEqual(incoming);
  });

  it('renews a URL only when that version is explicitly requested', () => {
    const previous = { id: 'version-1', previewSource: 'final', previewUrl: 'https://storage.example/expired-token' };
    const incoming = { id: 'version-1', previewSource: 'final', previewUrl: 'https://storage.example/fresh-token' };

    expect(preservePreviewUrl(incoming, previous, new Set(['version-1']))).toEqual(incoming);
  });

  it('preserves the current URL when a status-only response omits preview fields', () => {
    const previous = { id: 'version-1', previewSource: 'final', previewUrl: 'https://storage.example/stable-token' };
    const incoming = { id: 'version-1', status: 'generating' };

    expect(preservePreviewUrl(incoming, previous)).toEqual({
      ...incoming,
      previewUrl: previous.previewUrl,
      previewSource: previous.previewSource,
    });
  });
});
