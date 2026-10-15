import { describe, expect, it } from 'vitest';
import { HttpError } from '@/core/auth/guards';
import { assertPlaceUploadAdmin, assertVehicleDossierAdmin } from './permissions';

describe('asset upload permissions', () => {
  it('allows only admins to upload places', () => {
    expect(() => assertPlaceUploadAdmin('admin')).not.toThrow();
    for (const role of ['collaborateur', 'valideur'] as const) {
      expect(() => assertPlaceUploadAdmin(role)).toThrowError(HttpError);
      expect(() => assertPlaceUploadAdmin(role)).toThrow('L’ajout de lieux est réservé à l’administration.');
    }
  });

  it('allows only admins to attach photos to vehicle dossiers', () => {
    expect(() => assertVehicleDossierAdmin('admin')).not.toThrow();
    expect(() => assertVehicleDossierAdmin('collaborateur')).toThrowError(HttpError);
    expect(() => assertVehicleDossierAdmin('valideur')).toThrowError(HttpError);
  });
});
