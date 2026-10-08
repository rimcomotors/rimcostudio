'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const nav = [
  { label: 'Accueil', href: '/', icon: 'home' },
  { label: 'Studio', href: '/studio', icon: 'spark' },
  { label: 'Bibliothèque', href: '/bibliotheque', icon: 'film' },
  { label: 'Médiathèque', href: '/mediatheque', icon: 'image' },
  { label: 'Coûts', href: '/couts', icon: 'chart' },
  { label: 'Comparaison', href: '/comparaison', icon: 'compare' },
  { label: 'Admin', href: '/admin', icon: 'settings' },
];

const iconPaths: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9v11h13V9M9 20v-6h6v6',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z',
  film: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v5M15 4v5M9 15v5M15 15v5',
  image: 'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01',
  chart: 'M4 19V5M4 19h16M8 15l3-4 3 2 5-7',
  compare: 'M7 7h13M7 7l4-4M7 7l4 4M17 17H4m13 0-4-4m4 4-4 4',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.6 2.8-.2-.1a1.7 1.7 0 0 0-1.9.3l-.1.1h-3.2l-.1-.2a1.7 1.7 0 0 0-1.6-1 1.7 1.7 0 0 0-1.6 1l-.1.2H6.2l-.1-.1a1.7 1.7 0 0 0-1.9-.3l-.2.1-1.6-2.8.1-.1a1.7 1.7 0 0 0 .3-1.9l-.1-.2v-3.2l.2-.1a1.7 1.7 0 0 0 1-1.6 1.7 1.7 0 0 0-1-1.6l-.2-.1 1.6-2.8.2.1 1.9-.3.1-.1h3.2l.1.2a1.7 1.7 0 0 0 1.6 1 1.7 1.7 0 0 0 1.6-1l.1-.2h3.2l.1.1a1.7 1.7 0 0 0 1.9.3l.2-.1 1.6 2.8-.1.1a1.7 1.7 0 0 0-.3 1.9l.1.2v3.2l-.2.1a1.7 1.7 0 0 0-1 1.6',
};

function NavLink({ item, pathname, mobile = false }: { item: (typeof nav)[number]; pathname: string; mobile?: boolean }) {
  const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
  return <Link aria-current={active ? 'page' : undefined} href={item.href} className={`${mobile ? 'shrink-0' : 'w-full'} flex items-center gap-3 rounded-md px-3 py-2.5 text-xs font-medium ${active ? 'bg-[#fae9e8] text-[#b51d19]' : 'text-[#55545a] hover:bg-[#f2f2f3] hover:text-[#17171a]'}`}>
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[17px] shrink-0 fill-none stroke-current" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={iconPaths[item.icon]} /></svg>{item.label}
  </Link>;
}

export function AppShell({ children, mode }: { children: React.ReactNode; mode: 'mock' | 'live' }) {
  const pathname = usePathname();
  if (pathname === '/connexion') return <>{children}</>;
  const page = nav.find((item) => item.href === pathname)?.label ?? 'Studio';
  return <div className="min-h-screen bg-[var(--background)] text-[var(--ink)]">
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-[232px] flex-col border-r border-[var(--border)] bg-white px-4 py-6 text-[#17171a] lg:flex">
      <Link href="/" className="mb-10 flex items-center gap-3 px-2"><span className="grid size-10 place-items-center rounded-full border-2 border-[#c51e1c] text-lg font-black text-[#c51e1c]">R</span><span><strong className="block text-[15px] tracking-[.14em]">RIMCO</strong><small className="text-[9px] tracking-[.27em] text-[#77777d]">STUDIO VIDÉO</small></span></Link>
      <p className="mb-3 px-3 text-[9px] font-bold uppercase tracking-[.2em] text-[#8a8990]">Production</p>
      <nav className="space-y-1">{nav.slice(0, 4).map((item) => <NavLink key={item.href} item={item} pathname={pathname} />)}</nav>
      <p className="mb-3 mt-8 px-3 text-[9px] font-bold uppercase tracking-[.2em] text-[#8a8990]">Pilotage</p>
      <nav className="space-y-1">{nav.slice(4).map((item) => <NavLink key={item.href} item={item} pathname={pathname} />)}</nav>
      <div className="mt-auto border-t border-[var(--border)] pt-5"><p className="text-[9px] font-bold uppercase tracking-[.2em] text-[#8a8990]">Espace pilote</p><p className="mt-2 text-sm font-semibold">RIMCO Motors</p><p className="mt-1 text-xs text-[#77777d]">Abidjan · Côte d’Ivoire</p><Link href="/connexion" className="mt-4 flex items-center gap-3 rounded-md px-2 py-2 text-xs text-[#55545a] hover:bg-[#f2f2f3]"><span className="grid size-8 place-items-center rounded-full bg-[#f0eff1] font-bold">OM</span>Compte utilisateur</Link></div>
    </aside>
    <div className="lg:pl-[232px]">
      <header className="sticky top-0 z-10 flex h-[62px] items-center justify-between border-b border-[var(--border)] bg-white px-5 md:px-8"><div className="text-xs text-[#77777d]">RIMCO Motors <span className="px-2 text-[#c5c5ca]">/</span><span className="font-semibold text-[#242428]">{page}</span></div><div className="flex items-center gap-3"><span className={`rounded-sm px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-wider ${mode === 'mock' ? 'bg-[#efeff1] text-[#55555d]' : 'bg-[#fcebea] text-[#a51d19]'}`}>{mode === 'mock' ? 'Simulation' : 'Mode réel'}</span><span className="grid size-8 place-items-center rounded-full bg-[#151518] text-[10px] font-bold text-white">OM</span></div></header>
      <nav aria-label="Navigation principale" className="flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-white px-3 py-2 lg:hidden">{nav.map((item) => <NavLink key={item.href} item={item} pathname={pathname} mobile />)}</nav>
      <main id="main" className="mx-auto max-w-[1440px] p-5 md:px-8 md:py-8">{children}</main>
    </div>
  </div>;
}

export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="mb-8 flex flex-wrap items-end justify-between gap-5"><div><p className="mb-2 text-[10px] font-bold uppercase tracking-[.16em] text-[var(--brand-red)]">{eyebrow}</p><h1 className="text-[34px] leading-tight tracking-[-.02em] md:text-[42px]">{title}</h1><p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{description}</p></div>{action}</div>;
}

export function MetricCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: string }) {
  return <div className="border border-[var(--border)] bg-white p-5"><p className="text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{label}</p><div className="mt-4 flex items-end justify-between"><strong className="text-[27px] font-semibold tracking-[-.04em]">{value}</strong>{accent && <span className="bg-[#fae9e8] px-2.5 py-1 text-[10px] font-semibold text-[#9c2822]">{accent}</span>}</div><p className="mt-1.5 text-xs text-[var(--muted)]">{sub}</p></div>;
}

export function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = { Prête: 'bg-[#e9f2eb] text-[#42694a]', Génération: 'bg-[#fae9e8] text-[#9c2822]', Validation: 'bg-[#efeff1] text-[#55555d]', Brouillon: 'bg-[#efeff1] text-[#55555d]', Échec: 'bg-[#fae9e7] text-[#9d352e]' };
  return <span className={`inline-flex rounded-sm px-2.5 py-1 text-[10px] font-semibold ${colors[status] ?? 'bg-[#efeff1] text-[#55555d]'}`}>{status}</span>;
}
