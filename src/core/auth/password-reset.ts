import { z } from 'zod';

const emailSchema = z.string().trim().email();
type ResetClient = {
  auth: {
    resetPasswordForEmail(email: string, options: { redirectTo: string }): Promise<{ error: unknown | null }>;
  };
};

export type PasswordResetResult = { status: 'invalid' | 'sent' | 'failed' };

export async function sendPasswordResetEmail(client: ResetClient, email: string, origin: string): Promise<PasswordResetResult> {
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) return { status: 'invalid' };
  const { error } = await client.auth.resetPasswordForEmail(parsedEmail.data, { redirectTo: `${origin}/connexion` });
  return { status: error ? 'failed' : 'sent' };
}
