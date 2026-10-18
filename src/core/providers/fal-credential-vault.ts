import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/env';
import { HttpError } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { decryptFalCredential, encryptFalCredential, type EncryptedFalCredential } from './fal-credential-crypto';

type CredentialAdmin = SupabaseClient;
export type FalCredential = { id: string | null; apiKey: string };

function encryptionKey(): string {
  if (!env.FAL_CREDENTIALS_ENCRYPTION_KEY) {
    throw new HttpError(503, 'Configurez FAL_CREDENTIALS_ENCRYPTION_KEY dans Vercel avant d’enregistrer une clé Fal.');
  }
  return env.FAL_CREDENTIALS_ENCRYPTION_KEY;
}

function missingTable(error: { code?: string } | null): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205';
}

export async function getActiveFalCredential(admin: CredentialAdmin = createStorageAdminClient()): Promise<FalCredential> {
  const { data, error } = await admin.from('fal_provider_credentials')
    .select('id,ciphertext,nonce,auth_tag').eq('is_active', true).maybeSingle();
  if (error && !missingTable(error)) throw new HttpError(503, 'Impossible de lire la configuration Fal.');
  if (data) {
    const apiKey = decryptFalCredential({ ciphertext: data.ciphertext, nonce: data.nonce, authTag: data.auth_tag }, encryptionKey());
    return { id: data.id, apiKey };
  }
  if (env.FAL_KEY) return { id: null, apiKey: env.FAL_KEY };
  throw new HttpError(503, 'Aucune clé Fal n’est configurée. Ajoutez-la dans Administration → Connexion Fal.');
}

/** Null IDs belong to generations started with the legacy Vercel FAL_KEY. */
export async function getFalCredentialById(credentialId: string | null, admin: CredentialAdmin = createStorageAdminClient()): Promise<FalCredential> {
  if (!credentialId) {
    if (env.FAL_KEY) return { id: null, apiKey: env.FAL_KEY };
    throw new HttpError(503, 'La clé Fal historique n’est plus configurée dans Vercel.');
  }
  const { data, error } = await admin.from('fal_provider_credentials')
    .select('id,ciphertext,nonce,auth_tag').eq('id', credentialId).maybeSingle();
  if (error || !data) throw new HttpError(503, 'La clé Fal associée à cette génération est introuvable.');
  const apiKey = decryptFalCredential({ ciphertext: data.ciphertext, nonce: data.nonce, authTag: data.auth_tag }, encryptionKey());
  return { id: data.id, apiKey };
}

export async function getFalCredentialStatus(admin: CredentialAdmin = createStorageAdminClient()) {
  const { data, error } = await admin.from('fal_provider_credentials')
    .select('id,created_at,ciphertext,nonce,auth_tag').eq('is_active', true).maybeSingle();
  if (error && !missingTable(error)) throw new HttpError(503, 'Impossible de lire l’état de la connexion Fal.');
  if (data) decryptFalCredential({ ciphertext: data.ciphertext, nonce: data.nonce, authTag: data.auth_tag }, encryptionKey());
  return {
    configured: Boolean(data || env.FAL_KEY),
    source: data ? 'admin' as const : env.FAL_KEY ? 'vercel' as const : 'none' as const,
    updatedAt: data?.created_at ?? null,
    encryptionReady: Boolean(env.FAL_CREDENTIALS_ENCRYPTION_KEY),
  };
}

export async function replaceFalCredential(apiKey: string, actorId: string, admin: CredentialAdmin = createStorageAdminClient()) {
  const encrypted: EncryptedFalCredential = encryptFalCredential(apiKey, encryptionKey());
  const { data, error } = await admin.from('fal_provider_credentials').insert({
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    auth_tag: encrypted.authTag,
    created_by: actorId,
    is_active: false,
  }).select('id').single();
  if (error || !data) throw new HttpError(503, 'Impossible d’enregistrer la nouvelle clé Fal. Vérifiez que la migration SQL est appliquée.');

  const { error: activationError } = await admin.rpc('activate_fal_provider_credential', { p_credential_id: data.id });
  if (activationError) {
    await admin.from('fal_provider_credentials').delete().eq('id', data.id);
    throw new HttpError(503, 'Impossible d’activer la nouvelle clé Fal. Vérifiez que la migration SQL est appliquée.');
  }

  return { updatedAt: new Date().toISOString() };
}

export async function pruneRetiredFalCredentials(admin: CredentialAdmin = createStorageAdminClient()): Promise<void> {
  const { data: retired, error } = await admin.from('fal_provider_credentials').select('id').eq('is_active', false);
  if (error || !retired?.length) return;
  for (const credential of retired) {
    const { data: inFlight, error: versionError } = await admin.from('video_versions')
      .select('id').eq('fal_credential_id', credential.id).in('status', ['queued', 'generating']).limit(1);
    if (versionError || inFlight?.length) continue;
    await admin.from('fal_provider_credentials').delete().eq('id', credential.id).eq('is_active', false);
  }
}
