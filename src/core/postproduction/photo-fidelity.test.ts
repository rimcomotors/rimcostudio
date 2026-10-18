import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { hasPngAlphaChannel, hasTransparentPngPixels } from './photo-fidelity';
import { validatePhotoFidelityPlan, type PhotoFidelityShot } from '@/core/storyboard';

const shot = (durationSeconds: number, index = 1): PhotoFidelityShot => ({
  title: `Plan ${index}`, vehiclePhotoId: `vehicle-${index}`, locationPhotoId: `place-${index}`, durationSeconds,
});

describe('validation du mode Fidélité photo', () => {
  it('exige un seul plan de cinq secondes', () => {
    expect(() => validatePhotoFidelityPlan([shot(5)], 5)).not.toThrow();
    expect(() => validatePhotoFidelityPlan([shot(2), shot(3, 2)], 5)).toThrow(/un seul plan/i);
  });

  it('accepte plusieurs plans à partir de dix secondes si leur durée correspond', () => {
    expect(() => validatePhotoFidelityPlan([shot(5), shot(5, 2)], 10)).not.toThrow();
    expect(() => validatePhotoFidelityPlan([shot(4), shot(5, 2)], 10)).toThrow(/durée/i);
  });

  it('exige un lieu pour le plan court, mais permet un plan intérieur plein cadre dans un montage long', () => {
    expect(() => validatePhotoFidelityPlan([{ ...shot(5), locationPhotoId: null }], 5)).toThrow(/lieu/i);
    expect(() => validatePhotoFidelityPlan([{ ...shot(10), locationPhotoId: null }], 10)).not.toThrow();
  });
});

describe('transparence des références véhicule', () => {
  it('n’accepte qu’un PNG avec canal alpha pour le détourage', () => {
    const png = Buffer.alloc(26);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.write('IHDR', 12, 'ascii');
    png[24] = 8;
    png[25] = 6;
    expect(hasPngAlphaChannel(png)).toBe(true);
    png[25] = 2;
    expect(hasPngAlphaChannel(png)).toBe(false);
  });

  it('refuse un canal alpha entièrement opaque et accepte une image avec fond transparent', () => {
    const makePng = (alphas: number[]) => {
      const row = Buffer.from([0, ...alphas.flatMap((alpha) => [180, 20, 20, alpha])]);
      const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const result = Buffer.alloc(body.length + 8);
        result.writeUInt32BE(data.length, 0);
        body.copy(result, 4);
        result.writeUInt32BE(crc32(body), result.length - 4);
        return result;
      };
      const header = Buffer.alloc(13);
      header.writeUInt32BE(alphas.length, 0);
      header.writeUInt32BE(1, 4);
      header[8] = 8;
      header[9] = 6;
      const compressed = deflateSync(row);
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0)),
      ]);
    };
    expect(hasTransparentPngPixels(makePng([255, 255]))).toBe(false);
    expect(hasTransparentPngPixels(makePng([255, 0]))).toBe(true);
  });
});

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
