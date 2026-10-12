'use client';

import { useState, type FormEvent } from 'react';
import { createSupabaseBrowserClient } from '@/core/supabase/browser';
import { sendPasswordResetEmail } from '@/core/auth/password-reset';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSent(false);
    setBusy(true);
    try {
      const client = createSupabaseBrowserClient();
      const result = await sendPasswordResetEmail(client, email, window.location.origin);
      if (result.status === 'invalid') {
        setError('Saisissez une adresse e-mail valide.');
        return;
      }
      if (result.status === 'failed') throw new Error('L’e-mail de réinitialisation n’a pas pu être envoyé. Réessayez plus tard.');
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'La demande de réinitialisation a échoué.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-7 space-y-5">
      <label htmlFor="reset-email" className="block text-xs font-semibold text-[#504d48]">Adresse e-mail
        <input id="reset-email" name="email" autoComplete="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfdcd5] bg-[var(--surface)] px-4 py-3 text-sm font-normal outline-none focus:border-[var(--brand-red)] focus:ring-2 focus:ring-[var(--brand-red)]/15" />
      </label>
      {error && <p role="alert" className="rounded-lg bg-[#fae9e7] px-3 py-2.5 text-xs text-[#9b352d]">{error}</p>}
      {sent && <p role="status" className="rounded-lg bg-[#edf4ee] px-3 py-2.5 text-xs leading-5 text-[#456c4c]">Si un compte correspond à cette adresse, un lien de réinitialisation va être envoyé.</p>}
      <button type="submit" disabled={busy} className="w-full rounded-xl bg-[var(--brand-red)] py-3 text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-burgundy)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-red)] disabled:opacity-50">{busy ? 'Envoi…' : 'Envoyer le lien'}</button>
    </form>
  );
}
