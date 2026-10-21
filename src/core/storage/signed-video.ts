type SignedUrlResult = { data: { signedUrl: string } | null; error: unknown | null };
type SignedUrlCreator = (path: string, expiresIn: number, options?: { download?: string | boolean }) => Promise<SignedUrlResult>;
type CacheEntry = { signedUrl: string; expiresAt: number };

const MAX_CACHE_ENTRIES = 1_000;
const MAX_CACHE_AGE_MS = 50 * 60 * 1_000;
const EXPIRY_SAFETY_MS = 5 * 60 * 1_000;
const signedUrlCache = new Map<string, CacheEntry>();
const pendingSignedUrls = new Map<string, Promise<string | null>>();

/** Creates and reuses one short-lived signed URL per private Storage object and disposition. */
export async function createCachedSignedUrl(cacheKey: string, expiresIn: number, create: () => Promise<SignedUrlResult>) {
  const now = Date.now();
  const cached = signedUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    signedUrlCache.delete(cacheKey);
    signedUrlCache.set(cacheKey, cached);
    return cached.signedUrl;
  }
  signedUrlCache.delete(cacheKey);

  const pending = pendingSignedUrls.get(cacheKey);
  if (pending) return pending;

  const request = create().then(({ data, error }) => {
    if (error || !data?.signedUrl) return null;
    const ttl = Math.min(MAX_CACHE_AGE_MS, expiresIn * 1_000 - EXPIRY_SAFETY_MS);
    if (ttl <= 0) return data.signedUrl;
    signedUrlCache.set(cacheKey, { signedUrl: data.signedUrl, expiresAt: now + ttl });
    while (signedUrlCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = signedUrlCache.keys().next().value;
      if (!oldestKey) break;
      signedUrlCache.delete(oldestKey);
    }
    return data.signedUrl;
  }).finally(() => pendingSignedUrls.delete(cacheKey));
  pendingSignedUrls.set(cacheKey, request);
  return request;
}

/** Creates a reusable inline signed URL for an already-authorized private Storage object. */
export async function createSignedStorageObjectUrl(createSignedUrl: SignedUrlCreator, bucket: string, path: string) {
  return createCachedSignedUrl(`${bucket}:${path}:inline`, 3600, () => createSignedUrl(path, 3600));
}

export const createSignedStoragePreviewUrl = createSignedStorageObjectUrl;

/** Creates a reusable signed Storage URL with Content-Disposition set to attachment. */
export async function createSignedVideoDownloadUrl(createSignedUrl: SignedUrlCreator, path: string) {
  return createCachedSignedUrl(`videos:${path}:attachment`, 3600, () => createSignedUrl(path, 3600, { download: true }));
}

/** Tests can clear process-local tokens to stay isolated from one another. */
export function clearSignedUrlCache() {
  signedUrlCache.clear();
  pendingSignedUrls.clear();
}
