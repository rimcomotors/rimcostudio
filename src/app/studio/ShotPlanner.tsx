'use client';

export type ShotDraft = {
  title: string;
  scene: string;
  location: string;
  action: string;
  camera: string;
};

type ShotPair = [ShotDraft, ShotDraft];

type ShotPlannerProps = {
  value: readonly ShotDraft[];
  onChange: (value: ShotPair) => void;
};

export const defaultShotPlan: ShotPair = [
  {
    title: 'Plan 1 · Découverte',
    scene: 'Plan d’établissement',
    location: 'Abidjan, devant une architecture contemporaine',
    action: 'Le véhicule est présenté à l’arrêt dans son environnement.',
    camera: 'Plan large, travelling lent vers le véhicule',
  },
  {
    title: 'Plan 2 · Action',
    scene: 'Plan héro',
    location: 'Sur une voie dégagée à Abidjan',
    action: 'Le véhicule avance avec assurance et s’arrête face caméra.',
    camera: 'Travelling trois-quarts avant, puis léger rapprochement',
  },
];

const fields: Array<{ key: keyof ShotDraft; label: string; multiline?: boolean }> = [
  { key: 'title', label: 'Nom du plan' },
  { key: 'scene', label: 'Type de scène' },
  { key: 'location', label: 'Lieu', multiline: true },
  { key: 'action', label: 'Action du véhicule', multiline: true },
  { key: 'camera', label: 'Mouvement de caméra', multiline: true },
];

function normalizeShots(value: readonly ShotDraft[]): ShotPair {
  return [
    { ...defaultShotPlan[0], ...(value[0] ?? {}) },
    { ...defaultShotPlan[1], ...(value[1] ?? {}) },
  ];
}

export function ShotPlanner({ value, onChange }: ShotPlannerProps) {
  const shots = normalizeShots(value);

  function updateShot(index: 0 | 1, key: keyof ShotDraft, nextValue: string) {
    const nextShots = normalizeShots(value);
    const updatedShot = { ...nextShots[index], [key]: nextValue };
    onChange(index === 0
      ? [updatedShot, nextShots[1]]
      : [nextShots[0], updatedShot]);
  }

  return (
    <section aria-labelledby="shot-planner-heading" className="space-y-4">
      <div>
        <h2 id="shot-planner-heading" className="text-xl text-[var(--ink)]">Plans de la vidéo</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Deux plans générés séparément puis assemblés pour former le clip.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {shots.map((shot, index) => (
          <fieldset key={index} className="min-w-0 space-y-4 rounded-md border border-[var(--border)] bg-white p-4 md:p-5">
            <legend className="sr-only">Plan {index + 1}</legend>
            <div className="flex items-center gap-3 border-b border-[var(--border)] pb-3">
              <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--brand-red)] text-sm font-semibold text-white">
                {index + 1}
              </span>
              <h3 className="text-lg text-[var(--ink)]">{index === 0 ? 'Plan d’établissement' : 'Plan d’action / héro'}</h3>
            </div>

            {fields.map(({ key, label, multiline }) => {
              const id = `shot-${index + 1}-${key}`;
              const controlClass = 'mt-1.5 w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--brand-red)]';

              return (
                <div key={key}>
                  <label htmlFor={id} className="block text-sm font-medium text-[var(--ink)]">{label}</label>
                  {multiline ? (
                    <textarea
                      id={id}
                      rows={2}
                      className={`${controlClass} resize-y`}
                      value={shot[key]}
                      onChange={(event) => updateShot(index as 0 | 1, key, event.target.value)}
                    />
                  ) : (
                    <input
                      id={id}
                      className={controlClass}
                      value={shot[key]}
                      onChange={(event) => updateShot(index as 0 | 1, key, event.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
        ))}
      </div>
    </section>
  );
}
