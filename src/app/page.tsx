import Link from 'next/link';
import { PageHeading } from '@/components/shell';

const steps = [
  { number: '01', title: 'Choisissez un véhicule', description: 'Partez d’une photo réelle validée dans la médiathèque.', href: '/mediatheque', action: 'Voir les véhicules' },
  { number: '02', title: 'Décrivez la scène', description: 'Lieu, décor, lumière et format se règlent dans le Studio.', href: '/studio', action: 'Ouvrir le Studio' },
  { number: '03', title: 'Consultez le MP4', description: 'Suivez la génération, puis visionnez et téléchargez le résultat.', href: '/bibliotheque', action: 'Ouvrir la bibliothèque' },
];

export default function Home() {
  return <>
    <PageHeading eyebrow="RIMCO Motors · Abidjan" title="De la demande au MP4, en quelques minutes" description="Créez une vidéo automobile fidèle à la marque à partir d’une photo et d’une description simple." action={<Link href="/studio" className="rounded-md bg-[#c51e1c] px-5 py-3 text-sm font-semibold text-white hover:bg-[#a71715]">Créer une vidéo</Link>} />
    <section aria-labelledby="workflow-title" className="grid gap-8 border-y border-[#dedee1] py-7 md:grid-cols-[minmax(210px,.75fr)_2fr]">
      <div><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#c51e1c]">Studio vidéo</p><h2 id="workflow-title" className="mt-3 text-[25px] leading-tight">Vos équipes créent seules</h2><p className="mt-3 max-w-sm text-sm leading-6 text-[#626269]">Une demande en langage courant suffit. Les options RIMCO sont prêtes à l’emploi et chaque génération affiche son prix avant lancement.</p></div>
      <ol className="divide-y divide-[#e2e2e5]">{steps.map((step) => <li key={step.number} className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[42px_1fr_auto] sm:items-center"><span className="font-[family-name:var(--font-display)] text-[25px] text-[#c51e1c]">{step.number}</span><div><h3 className="text-base">{step.title}</h3><p className="mt-1 text-sm text-[#626269]">{step.description}</p></div><Link href={step.href} className="text-xs font-semibold text-[#831810] underline decoration-[#d6a7a4] underline-offset-4">{step.action}</Link></li>)}</ol>
    </section>
    <section className="mt-7 flex flex-wrap items-center justify-between gap-4 border border-[#e2e2e5] bg-white px-5 py-5 md:px-6">
      <div><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#c51e1c]">Chaque FCFA sous contrôle</p><p className="mt-2 text-base font-semibold">Le prix facturé est connu avant de lancer la génération.</p></div>
      <Link href="/couts" className="rounded-md border border-[#d7d7db] px-4 py-2.5 text-xs font-semibold text-[#29292e] hover:bg-[#f4f4f5]">Consulter les coûts</Link>
    </section>
  </>;
}
