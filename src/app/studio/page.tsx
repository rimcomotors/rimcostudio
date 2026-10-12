import { PageHeading } from '@/components/shell';
import { StudioComposer } from './StudioComposer';
import { env } from '@/env';
import { getActor } from '@/core/auth/guards';

export default async function StudioPage() {
  await getActor();
  return <>
    <PageHeading eyebrow="Atelier de création" title="Créer un montage test" description="Décrivez deux plans courts, générez-les séparément et assemblez-les autour de la photo du véhicule." />
    {env.PROVIDERS_MODE === 'mock' && <p role="status" className="mb-5 border border-[#e7d7b9] bg-[#fbf6ed] p-4 text-sm leading-6 text-[#765d39]">
      <strong>Mode simulation :</strong> cet environnement ne contacte pas fal.ai et ne produit pas de vraie vidéo. Pour tester une génération réelle, ouvrez le déploiement Preview configuré en mode live.
    </p>}
    <StudioComposer mode={env.PROVIDERS_MODE} />
  </>;
}
