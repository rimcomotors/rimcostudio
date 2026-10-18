import { describe, expect, it } from 'vitest';
import { decryptFalCredential, encryptFalCredential } from './fal-credential-crypto';

const masterKey = Buffer.alloc(32, 7).toString('base64');

describe('Fal credential encryption', () => {
  it('round-trips a key without storing plaintext in the payload', () => {
    const exampleCredential = 'example-fal-credential';
    const encrypted = encryptFalCredential(exampleCredential, masterKey);

    expect(JSON.stringify(encrypted)).not.toContain(exampleCredential);
    expect(decryptFalCredential(encrypted, masterKey)).toBe(exampleCredential);
  });

  it('uses a fresh nonce for each encryption', () => {
    const first = encryptFalCredential('fal-test-account-secret-123456', masterKey);
    const second = encryptFalCredential('fal-test-account-secret-123456', masterKey);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects a master key with the wrong length', () => {
    expect(() => encryptFalCredential('fal-test-account-secret-123456', Buffer.alloc(16).toString('base64')))
      .toThrow('32 octets');
  });

  it('rejects modified ciphertext without returning plaintext or crypto details', () => {
    const encrypted = encryptFalCredential('fal-test-account-secret-123456', masterKey);
    const tampered = { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` };

    expect(() => decryptFalCredential(tampered, masterKey)).toThrow('Impossible de déchiffrer la clé Fal');
  });
});
