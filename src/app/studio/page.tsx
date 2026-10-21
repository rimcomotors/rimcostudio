import { PageHeading } from '@/components/shell';
import { StudioComposer } from './StudioComposer';
import { env } from '@/env';
import { requirePageRole } from '@/core/auth/guards';

export default async function StudioPage() {
  await requirePageRole('collaborateur', 'admin');
  return <>
    <PageHeading eyebrow="Atelier de création" title="Créer une vidéo" description="Décrivez votre idée et choisissez vos références. Le Studio construit les plans et assemble automatiquement une vidéo adaptée à votre demande." />
    {env.PROVIDERS_MODE === 'mock' && <p role="status" className="mb-5 border border-[#e7d7b9] bg-[#fbf6ed] p-4 text-sm leading-6 text-[#765d39]">
      <strong>Mode simulation :</strong> cet environnement ne lance pas de génération vidéo réelle. Pour tester une génération réelle, ouvrez le déploiement Preview configuré en mode live.
    </p>}
    <StudioComposer mode={env.PROVIDERS_MODE} />
  </>;
}
