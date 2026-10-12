import Link from 'next/link';
import { ForgotPasswordForm } from './ForgotPasswordForm';

export default function ForgotPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--background)] px-6 py-12">
      <section className="w-full max-w-[420px] rounded-2xl border border-black/[.055] bg-[var(--surface)] p-7 shadow-sm sm:p-9">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-[var(--brand-red)] text-lg font-black text-white">R</span>
          <span><b className="block text-sm tracking-[.16em]">RIMCO</b><small className="text-[9px] tracking-[.26em] text-[var(--muted)]">STUDIO</small></span>
        </div>
        <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[var(--brand-red)]">Accès sécurisé</p>
        <h1 className="mt-2 text-[28px] font-semibold tracking-[-.04em]">Mot de passe oublié</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Saisissez votre adresse e-mail. Si un compte y est associé, vous recevrez un lien pour choisir un nouveau mot de passe.</p>
        <ForgotPasswordForm />
        <Link href="/connexion" className="mt-6 inline-block text-xs font-semibold text-[var(--brand-red)] underline underline-offset-4">Retour à la connexion</Link>
      </section>
    </main>
  );
}
