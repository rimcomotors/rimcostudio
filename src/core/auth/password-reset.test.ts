import { describe, expect, it, vi } from 'vitest';
import { sendPasswordResetEmail } from './password-reset';

describe('password reset request', () => {
  it('trims and sends a valid email with the application return URL', async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
    const result = await sendPasswordResetEmail({ auth: { resetPasswordForEmail } }, '  user@example.com  ', 'https://rimco.example');

    expect(result).toEqual({ status: 'sent' });
    expect(resetPasswordForEmail).toHaveBeenCalledWith('user@example.com', { redirectTo: 'https://rimco.example/connexion' });
  });

  it('does not call Supabase when the email is invalid', async () => {
    const resetPasswordForEmail = vi.fn();
    const result = await sendPasswordResetEmail({ auth: { resetPasswordForEmail } }, 'not-an-email', 'https://rimco.example');

    expect(result).toEqual({ status: 'invalid' });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it('reports a failed request without exposing the account state', async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: new Error('provider detail') });
    const result = await sendPasswordResetEmail({ auth: { resetPasswordForEmail } }, 'user@example.com', 'https://rimco.example');

    expect(result).toEqual({ status: 'failed' });
  });
});
