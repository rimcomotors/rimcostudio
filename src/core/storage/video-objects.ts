import { createHash } from 'node:crypto';

export type VideoObjectProvider = 'supabase' | 'r2';

export type SupabaseVideoBucket = {
  upload: (path: string, body: Buffer, options: { contentType: string; upsert: boolean }) => Promise<{ error: unknown | null }>;
  createSignedUrl: (path: string, expiresIn: number, options?: { download?: string | boolean }) => Promise<{ data: { signedUrl: string } | null; error: unknown | null }>;
  download: (path: string) => Promise<{ data: Blob | null; error: unknown | null }>;
  remove: (paths: string[]) => Promise<{ error: unknown | null }>;
};

export type R2ObjectClient = {
  put: (bucket: string, key: string, body: Buffer, contentType: string) => Promise<void>;
  signGet: (bucket: string, key: string, expiresIn: number, download: boolean) => Promise<string>;
  delete: (bucket: string, keys: string[]) => Promise<void>;
  head: (bucket: string, key: string) => Promise<{ size: number; sha256: string | undefined }>;
};

type GatewayOptions = {
  provider: VideoObjectProvider;
  bucket: string;
  supabase: SupabaseVideoBucket;
  r2?: R2ObjectClient;
};

type ReadOptions = { expiresIn: number; download?: boolean };
const R2_PREFIX = 'r2://';

function r2Key(path: string) {
  if (!path.startsWith(R2_PREFIX)) return null;
  const key = path.slice(R2_PREFIX.length);
  if (!key || key.startsWith('/') || key.includes('\\') || key.split('/').some((part) => !part || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error('Chemin vidéo R2 invalide.');
  }
  return key;
}

function assertValidLegacyPath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('Chemin vidéo invalide.');
  }
}

export function createVideoObjectGateway(options: GatewayOptions) {
  const requireR2 = () => {
    if (!options.r2) throw new Error('Le stockage vidéo R2 n’est pas configuré sur ce déploiement.');
    return options.r2;
  };

  return {
    async uploadFinal(path: string, body: Buffer) {
      assertValidLegacyPath(path);
      if (options.provider === 'r2') {
        await requireR2().put(options.bucket, path, body, 'video/mp4');
        return `${R2_PREFIX}${path}`;
      }
      const { error } = await options.supabase.upload(path, body, { contentType: 'video/mp4', upsert: true });
      if (error) throw error;
      return path;
    },

    async createReadUrl(path: string, readOptions: ReadOptions) {
      const key = r2Key(path);
      if (key) return requireR2().signGet(options.bucket, key, readOptions.expiresIn, readOptions.download === true);
      assertValidLegacyPath(path);
      const result = await options.supabase.createSignedUrl(path, readOptions.expiresIn, readOptions.download ? { download: true } : undefined);
      if (result.error || !result.data?.signedUrl) throw result.error ?? new Error('Impossible de créer le lien temporaire de la vidéo.');
      return result.data.signedUrl;
    },

    async migrateLegacyFinal(path: string) {
      const existingKey = r2Key(path);
      if (existingKey) return path;
      assertValidLegacyPath(path);
      const r2 = requireR2();
      const { data, error } = await options.supabase.download(path);
      if (error || !data) throw error ?? new Error('Impossible de lire la vidéo existante dans Supabase.');
      if (data.size > 100 * 1024 * 1024) throw new Error('La vidéo dépasse la taille maximale de migration de 100 Mo.');
      const body = Buffer.from(await data.arrayBuffer());
      if (body.length < 12 || body.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Le fichier source n’est pas un MP4 valide.');
      const checksum = createHash('sha256').update(body).digest('hex');
      await r2.put(options.bucket, path, body, 'video/mp4');
      const stored = await r2.head(options.bucket, path);
      if (stored.size !== body.length || stored.sha256 !== checksum) throw new Error('La vérification du fichier copié vers R2 a échoué.');
      return `${R2_PREFIX}${path}`;
    },

    async remove(paths: string[]) {
      const r2Keys: string[] = [];
      const legacyPaths: string[] = [];
      for (const path of new Set(paths)) {
        const key = r2Key(path);
        if (key) r2Keys.push(key);
        else {
          assertValidLegacyPath(path);
          legacyPaths.push(path);
        }
      }
      if (r2Keys.length) await requireR2().delete(options.bucket, r2Keys);
      if (legacyPaths.length) {
        const { error } = await options.supabase.remove(legacyPaths);
        if (error) throw error;
      }
    },
  };
}
