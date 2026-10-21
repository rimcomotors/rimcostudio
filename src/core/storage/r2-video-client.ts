import 'server-only';
import { createHash } from 'node:crypto';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/env';
import type { R2ObjectClient } from './video-objects';

let client: S3Client | undefined;

function getClient() {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error('Le stockage vidéo R2 n’est pas configuré sur ce déploiement.');
  }
  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  return client;
}

export const r2VideoClient: R2ObjectClient = {
  async put(bucket, key, body, contentType) {
    const sha256 = createHash('sha256').update(body).digest('hex');
    await getClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, Metadata: { sha256 } }));
  },
  async signGet(bucket, key, expiresIn, download) {
    return getSignedUrl(getClient(), new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(download ? { ResponseContentDisposition: 'attachment; filename="video.mp4"' } : {}),
    }), { expiresIn });
  },
  async delete(bucket, keys) {
    for (let index = 0; index < keys.length; index += 1000) {
      const result = await getClient().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })) } }));
      if (result.Errors?.length) throw new Error(`R2 a refusé la suppression de ${result.Errors.length} objet(s).`);
    }
  },
  async head(bucket, key) {
    const result = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (typeof result.ContentLength !== 'number') throw new Error('La taille du fichier R2 est indisponible.');
    return { size: result.ContentLength, sha256: result.Metadata?.sha256 };
  },
};
