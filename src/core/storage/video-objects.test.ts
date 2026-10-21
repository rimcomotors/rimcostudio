import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createVideoObjectGateway, type R2ObjectClient, type SupabaseVideoBucket } from './video-objects';

function makeSupabaseBucket(): SupabaseVideoBucket {
  return {
    upload: vi.fn().mockResolvedValue({ error: null }),
    createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://supabase.example/signed' }, error: null }),
    download: vi.fn().mockResolvedValue({ data: new Blob([Buffer.from('0000ftypmp42')]), error: null }),
    remove: vi.fn().mockResolvedValue({ error: null }),
  };
}

function makeR2Client(): R2ObjectClient {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    signGet: vi.fn().mockResolvedValue('https://r2.example/signed'),
    delete: vi.fn().mockResolvedValue(undefined),
    head: vi.fn().mockImplementation(async () => {
      const bytes = Buffer.from('0000ftypmp42');
      return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }),
  };
}

describe('video object gateway', () => {
  it('writes new finals to R2 and signs a private download URL', async () => {
    const supabase = makeSupabaseBucket();
    const r2 = makeR2Client();
    const gateway = createVideoObjectGateway({ provider: 'r2', bucket: 'rimco-videos', supabase, r2 });

    const storedPath = await gateway.uploadFinal('video/version/final.mp4', Buffer.from('mp4'));
    const url = await gateway.createReadUrl(storedPath, { expiresIn: 3600, download: true });

    expect(storedPath).toBe('r2://video/version/final.mp4');
    expect(r2.put).toHaveBeenCalledWith('rimco-videos', 'video/version/final.mp4', expect.any(Buffer), 'video/mp4');
    expect(r2.signGet).toHaveBeenCalledWith('rimco-videos', 'video/version/final.mp4', 3600, true);
    expect(url).toBe('https://r2.example/signed');
    expect(supabase.upload).not.toHaveBeenCalled();
  });

  it('keeps legacy Supabase paths readable while R2 is enabled', async () => {
    const supabase = makeSupabaseBucket();
    const r2 = makeR2Client();
    const gateway = createVideoObjectGateway({ provider: 'r2', bucket: 'rimco-videos', supabase, r2 });

    await expect(gateway.createReadUrl('video/version/final.mp4', { expiresIn: 3600 })).resolves.toBe('https://supabase.example/signed');
    expect(supabase.createSignedUrl).toHaveBeenCalledWith('video/version/final.mp4', 3600, undefined);
    expect(r2.signGet).not.toHaveBeenCalled();
  });

  it('removes legacy and R2 objects through their corresponding stores', async () => {
    const supabase = makeSupabaseBucket();
    const r2 = makeR2Client();
    const gateway = createVideoObjectGateway({ provider: 'r2', bucket: 'rimco-videos', supabase, r2 });

    await gateway.remove(['old/video.mp4', 'r2://new/video.mp4']);

    expect(r2.delete).toHaveBeenCalledWith('rimco-videos', ['new/video.mp4']);
    expect(supabase.remove).toHaveBeenCalledWith(['old/video.mp4']);
  });

  it('rejects malformed R2 paths rather than treating them as object keys', async () => {
    const gateway = createVideoObjectGateway({ provider: 'r2', bucket: 'rimco-videos', supabase: makeSupabaseBucket(), r2: makeR2Client() });
    await expect(gateway.createReadUrl('r2://../../secret', { expiresIn: 60 })).rejects.toThrow('Chemin vidéo R2 invalide.');
  });

  it('copies legacy MP4s to R2 and checks their size and checksum before returning a new path', async () => {
    const supabase = makeSupabaseBucket();
    const r2 = makeR2Client();
    const gateway = createVideoObjectGateway({ provider: 'r2', bucket: 'rimco-videos', supabase, r2 });

    await expect(gateway.migrateLegacyFinal('old/version/final.mp4')).resolves.toBe('r2://old/version/final.mp4');
    expect(r2.put).toHaveBeenCalledWith('rimco-videos', 'old/version/final.mp4', expect.any(Buffer), 'video/mp4');
    expect(r2.head).toHaveBeenCalledWith('rimco-videos', 'old/version/final.mp4');
  });

  it('does not migrate or expose an invalid source file', async () => {
    const supabase = makeSupabaseBucket();
    supabase.download = vi.fn().mockResolvedValue({ data: new Blob(['not a video']), error: null });
    const r2 = makeR2Client();
    const gateway = createVideoObjectGateway({ provider: 'r2', bucket: 'rimco-videos', supabase, r2 });

    await expect(gateway.migrateLegacyFinal('old/version/final.mp4')).rejects.toThrow('Le fichier source n’est pas un MP4 valide.');
    expect(r2.put).not.toHaveBeenCalled();
  });

  it('keeps the legacy path when the copied object fails verification', async () => {
    const r2 = makeR2Client();
    r2.head = vi.fn().mockResolvedValue({ size: 999, sha256: 'wrong-checksum' });
    const gateway = createVideoObjectGateway({ provider: 'r2', bucket: 'rimco-videos', supabase: makeSupabaseBucket(), r2 });

    await expect(gateway.migrateLegacyFinal('old/version/final.mp4')).rejects.toThrow('La vérification du fichier copié vers R2 a échoué.');
  });
});
