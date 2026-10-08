'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseBrowserClient } from '@/core/supabase/browser';

type FirstAccess = 'invite' | 'recovery';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [firstAccess, setFirstAccess] = useState<FirstAccess | null>(null);
  const [authVerified, setAuthVerified] = useState(false);
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const type = new URLSearchParams(window.location.hash.slice(1)).get('type');
    if (type !== 'invite' && type !== 'recovery') return;

    let active = true;
    try {
      const client = createSupabaseBrowserClient();
      setSupabase(client);
      setFirstAccess(type);
      void client.auth.getSession().then(({ data, error: sessionError }) => {
        if (!active) return;
        if (sessionError || !data.session) {
          setError('Ce lien de première connexion a expiré ou a déjà été utilisé. Demandez un nouvel e-mail à l’administrateur.');
          return;
        }
        setAuthVerified(true);
        window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
      }).catch(() => {
        if (active) setError('Impossible de vérifier ce lien. Demandez un nouvel e-mail à l’administrateur.');
      });
    } catch {
      setError('La configuration Supabase est incomplète. Contactez l’administrateur.');
    }

    return () => {
      active = false;
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const client = supabase ?? createSupabaseBrowserClient();
      if (firstAccess) {
        if (password.length < 12) throw new Error('Choisissez un mot de passe de 12 caractères minimum.');
        if (password !== passwordConfirmation) throw new Error('Les deux mots de passe ne correspondent pas.');
        const { error: updateError } = await client.auth.updateUser({ password });
        if (updateError) throw new Error('Le mot de passe n’a pas pu être enregistré. Vérifiez que le lien est encore valide.');
      } else {
        const { error: signInError } = await client.auth.signInWithPassword({ email, password });
        if (signInError) throw new Error('E-mail ou mot de passe incorrect.');
      }
      router.replace('/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'La connexion a échoué.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-7 space-y-5">
      {!firstAccess && <label htmlFor="email" className="block text-xs font-semibold text-[#504d48]">Adresse e-mail<input id="email" autoComplete="username" type="email" required value={email} onChange={event => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfdcd5] bg-[var(--surface)] px-4 py-3 text-sm outline-none focus:border-[var(--brand-red)] focus:ring-2 focus:ring-[var(--brand-red)]/15" /></label>}
      <label htmlFor="password" className="block text-xs font-semibold text-[#504d48]">{firstAccess ? 'Nouveau mot de passe' : 'Mot de passe'}<input id="password" autoComplete={firstAccess ? 'new-password' : 'current-password'} type="password" minLength={firstAccess ? 12 : undefined} required value={password} onChange={event => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfdcd5] bg-[var(--surface)] px-4 py-3 text-sm outline-none focus:border-[var(--brand-red)] focus:ring-2 focus:ring-[var(--brand-red)]/15" /></label>
      {firstAccess && <label htmlFor="password-confirmation" className="block text-xs font-semibold text-[#504d48]">Confirmez le mot de passe<input id="password-confirmation" autoComplete="new-password" type="password" minLength={12} required value={passwordConfirmation} onChange={event => setPasswordConfirmation(event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfdcd5] bg-[var(--surface)] px-4 py-3 text-sm outline-none focus:border-[var(--brand-red)] focus:ring-2 focus:ring-[var(--brand-red)]/15" /></label>}
      {firstAccess && <p className="text-[11px] leading-5 text-[#716d66]">12 caractères minimum. Ce mot de passe reste privé : ne le partagez pas.</p>}
      {error && <p role="alert" className="rounded-lg bg-[#fae9e7] px-3 py-2.5 text-xs text-[#9b352d]">{error}</p>}
      <button disabled={busy || (firstAccess !== null && !authVerified)} className="w-full rounded-xl bg-[var(--brand-red)] py-3 text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-burgundy)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-red)] disabled:opacity-50">{busy ? 'Patientez…' : firstAccess ? 'Activer mon compte' : 'Se connecter'}</button>
    </form>
  );
}
