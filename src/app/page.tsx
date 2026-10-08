import Link from 'next/link';
import {PageHeading} from '@/components/shell';

const steps=[
  {number:'01',title:'Choisir un véhicule',description:'Sélectionnez une photo de véhicule disponible dans la médiathèque.',href:'/mediatheque',action:'Ouvrir la médiathèque'},
  {number:'02',title:'Composer la scène',description:'Décrivez le lieu, la lumière et le mouvement autour du véhicule choisi.',href:'/studio',action:'Ouvrir le studio'},
  {number:'03',title:'Consulter et livrer',description:'Suivez la génération, visionnez le résultat puis téléchargez la vidéo prête.',href:'/bibliotheque',action:'Voir les vidéos'},
];

export default function Home(){return <>
  <PageHeading eyebrow="RIMCO Motors · Abidjan" title="Atelier de production" description="Un espace partagé pour préparer, générer, visionner et télécharger des vidéos automobiles." action={<Link href="/studio" className="rounded-md bg-[#c51e1c] px-5 py-3 text-sm font-semibold text-white hover:bg-[#a71715]">Créer une vidéo</Link>}/>
  <section aria-labelledby="workflow-title" className="grid gap-10 border-y border-[#d2cec6] py-8 md:grid-cols-[minmax(180px,.7fr)_2fr]">
    <div><p className="text-xs font-semibold uppercase tracking-wider text-[#831810]">Flux de production</p><h2 id="workflow-title" className="mt-3 text-2xl">Du véhicule à la vidéo prête</h2><p className="mt-3 max-w-sm text-sm leading-6 text-[#716d66]">Générez un clip, visionnez le résultat dans votre bibliothèque et téléchargez le MP4 dès qu’il est prêt.</p></div>
    <ol className="divide-y divide-[#e4e1db]">{steps.map(step=><li key={step.number} className="grid gap-3 py-5 first:pt-0 last:pb-0 sm:grid-cols-[44px_1fr_auto] sm:items-center"><span className="font-[family-name:var(--font-display)] text-2xl text-[#c51e1c]">{step.number}</span><div><h3 className="text-base">{step.title}</h3><p className="mt-1 text-sm text-[#716d66]">{step.description}</p></div><Link href={step.href} className="text-sm font-semibold text-[#831810] underline decoration-[#c9aaa6] underline-offset-4">{step.action}</Link></li>)}</ol>
  </section>
  <section className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-lg bg-[#831810] px-6 py-5 text-white"><div><p className="text-xs font-semibold uppercase tracking-wider text-white/70">Règle de production</p><p className="mt-2 text-lg">Une photo validée garantit l’identité du véhicule dans le brief.</p></div><Link href="/mediatheque" className="rounded-md border border-white/40 px-4 py-2.5 text-sm font-semibold hover:bg-white/10">Préparer les médias</Link></section>
</>}
