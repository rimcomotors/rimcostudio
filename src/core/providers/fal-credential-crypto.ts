import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedFalCredential = {
  ciphertext: string;
  nonce: string;
  authTag: string;
};

const AAD = Buffer.from('rimco-studio:fal-credential:v1');

function parseMasterKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) {
    throw new Error('La clé de chiffrement Fal doit être une clé Base64 de 32 octets.');
  }
  return key;
}

export function encryptFalCredential(apiKey: string, encodedMasterKey: string): EncryptedFalCredential {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) throw new Error('La clé API Fal est vide.');

  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', parseMasterKey(encodedMasterKey), nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(normalizedApiKey, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptFalCredential(encrypted: EncryptedFalCredential, encodedMasterKey: string): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', parseMasterKey(encodedMasterKey), Buffer.from(encrypted.nonce, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Impossible de déchiffrer la clé Fal. Vérifiez la clé de chiffrement configurée dans Vercel.');
  }
}
