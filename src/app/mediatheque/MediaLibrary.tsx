'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { createSupabaseBrowserClient } from '@/core/supabase/browser';

type Asset = {
  id: string;
  kind: 'vehicle' | 'logo' | 'audio';
  make?: string;
  model?: string;
  color?: string;
  angle?: string;
  variant?: string;
  status: 'en_attente' | 'validée' | 'rejetée';
  previewUrl?: string;
  path?: string;
  review_reason?: string;
};

const kinds: Array<[Asset['kind'], string]> = [
  ['vehicle', 'Véhicule'],
  ['logo', 'Logo'],
  ['audio', 'Audio'],
];

export function MediaLibrary() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [filter, setFilter] = useState<'all' | Asset['kind']>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [kind, setKind] = useState<Asset['kind']>('vehicle');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');
  const [rejecting, setRejecting] = useState('');
  const [reason, setReason] = useState('');

  async function load() {
    setLoading(true);
    try {
      const response = await fetch('/api/assets');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Impossible de charger la médiathèque.');
      setAssets(data.assets ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Une erreur est survenue.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function upload(file: File) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const maxSize = kind === 'audio' ? 25 * 1024 * 1024 : 12 * 1024 * 1024;
      const accepted = kind === 'audio'
        ? ['audio/mpeg', 'audio/wav', 'audio/mp4']
        : ['image/jpeg', 'image/png', 'image/webp'];
      if (!accepted.includes(file.type)) throw new Error('Format accepté : JPG, PNG ou WebP pour une image; MP3, WAV ou M4A pour un audio.');
      if (file.size > maxSize) throw new Error(`Le fichier dépasse la limite de ${kind === 'audio' ? '25' : '12'} Mo.`);
      if (kind === 'vehicle' && (!make.trim() || !model.trim())) throw new Error('Renseignez la marque et le modèle avant le téléversement.');

      const signed = await fetch('/api/media/upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, kind }),
      });
      const signedData = await signed.json();
      if (!signed.ok) throw new Error(signedData.error ?? 'Le téléversement signé n’est pas disponible.');
      if (signedData.mock || !signedData.token) throw new Error('Le téléversement nécessite Supabase configuré. Ajoutez les variables Supabase dans Vercel ou utilisez un aperçu connecté.');

      const supabase = createSupabaseBrowserClient();
      const bucket = kind === 'audio' ? 'audio' : kind === 'logo' ? 'brand' : 'assets';
      const { error: uploadError } = await supabase.storage.from(bucket).uploadToSignedUrl(signedData.path, signedData.token, file, { contentType: file.type });
      if (uploadError) throw new Error('Le transfert a échoué. Vérifiez votre connexion puis réessayez.');

      const metadata = kind === 'vehicle'
        ? { make: make.trim(), model: model.trim(), color: color.trim(), angle: '3/4 avant' }
        : kind === 'logo'
          ? { variant: 'rouge' }
          : {};
      const saved = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, path: signedData.path, ...metadata }),
      });
      const savedData = await saved.json();
      if (!saved.ok) throw new Error(savedData.error ?? 'Le fichier est transféré, mais son enregistrement a échoué.');
      setNotice('Fichier ajouté. Il sera visible dans la médiathèque après validation par l’administration.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  async function approve(asset: Asset, status: Asset['status']) {
    setError('');
    if (status === 'rejetée' && !reason.trim()) {
      setError('Indiquez un motif avant de refuser le média.');
      return;
    }
    const response = await fetch(`/api/admin/assets/${asset.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, reason: status === 'rejetée' ? reason.trim() : undefined }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error ?? 'Cette action est réservée à l’administration.');
      return;
    }
    setNotice(status === 'validée' ? 'Média validé.' : 'Média refusé.');
    setRejecting('');
    setReason('');
    await load();
  }

  const filtered = assets.filter((asset) => filter === 'all' || asset.kind === filter);
  const pending = assets.filter((asset) => asset.status === 'en_attente').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex gap-2 rounded-lg border border-[#e4e1db] bg-[#f5f5f3] p-1">
            {([['all', 'Tout'], ...kinds] as Array<['all' | Asset['kind'], string]>).map(([value, label]) => (
              <button key={value} onClick={() => {
                setFilter(value);
                if (value !== 'all') {
                  setKind(value);
                  setError('');
                  setNotice('');
                }
              }} className={`rounded-md px-3 py-2 text-xs font-semibold transition ${filter === value ? 'bg-[#fbfbfa] text-[#253b4e]' : 'text-[#716d66] hover:text-[#253b4e]'}`}>
                {label}{value === 'all' ? ` · ${assets.length}` : ''}
              </button>
            ))}
          </div>
          <label className="grid gap-1 text-xs font-semibold text-[#253b4e]">
            Type du média à ajouter
            <select value={kind} onChange={(event) => {
              setKind(event.target.value as Asset['kind']);
              setError('');
              setNotice('');
            }} className="rounded-md border border-[#d2cec6] bg-[#fbfbfa] px-3 py-2">
              {kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {kind === 'vehicle' && (
            <>
              <label className="grid gap-1 text-xs font-semibold text-[#253b4e]">Marque<input value={make} onChange={(event) => setMake(event.target.value)} className="rounded-md border border-[#d2cec6] bg-[#fbfbfa] px-3 py-2" /></label>
              <label className="grid gap-1 text-xs font-semibold text-[#253b4e]">Modèle<input value={model} onChange={(event) => setModel(event.target.value)} className="rounded-md border border-[#d2cec6] bg-[#fbfbfa] px-3 py-2" /></label>
              <label className="grid gap-1 text-xs font-semibold text-[#253b4e]">Couleur<input value={color} onChange={(event) => setColor(event.target.value)} className="rounded-md border border-[#d2cec6] bg-[#fbfbfa] px-3 py-2" /></label>
            </>
          )}
        </div>
        <label className="cursor-pointer rounded-md bg-[#c51e1c] px-4 py-3 text-xs font-semibold text-white hover:bg-[#a71715] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2">
          {busy ? 'Téléversement…' : 'Ajouter un média'}
          <input className="sr-only" type="file" accept={kind === 'audio' ? '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4' : 'image/jpeg,image/png,image/webp'} disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void upload(file); event.currentTarget.value = ''; }} />
        </label>
      </div>

      {notice && <p role="status" className="rounded-xl bg-[#edf4ee] px-4 py-3 text-sm text-[#456c4c]">{notice}</p>}
      {error && <p role="alert" className="rounded-xl bg-[#fbefed] px-4 py-3 text-sm text-[#9c3830]">{error}</p>}
      {pending > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-[#eadfc7] bg-[#fbf6ed] p-4">
          <span aria-hidden="true" className="mt-0.5 text-[#716d66]">•</span>
          <div>
            <p className="text-xs font-semibold text-[#675432]">{pending} média{pending > 1 ? 's' : ''} en attente</p>
            <p className="mt-1 text-xs text-[#87795e]">Ces fichiers doivent être validés par un administrateur avant utilisation.</p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((item) => <div key={item} className="h-64 animate-pulse rounded-2xl bg-[#e9e7e2]" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState onFile={(file) => void upload(file)} kind={kind} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((asset) => (
            <article key={asset.id} className="overflow-hidden rounded-2xl border border-black/[.055] bg-white">
              <AssetPreview asset={asset} />
              <div className="p-4">
                <p className="text-[9px] font-bold uppercase tracking-[.18em] text-[#ad3d34]">{asset.kind === 'vehicle' ? 'Photo véhicule' : asset.kind === 'logo' ? 'Logo RIMCO' : 'Piste audio'}</p>
                <h3 className="mt-1.5 text-sm font-semibold">{asset.kind === 'vehicle' ? `${asset.make ?? 'Véhicule'} ${asset.model ?? ''}` : asset.kind === 'logo' ? `Logo · ${asset.variant ?? 'rouge'}` : 'Piste audio'}</h3>
                <p className="mt-1 text-xs text-[#918c85]">{asset.color ?? asset.angle ?? asset.variant ?? 'RIMCO Motors'}</p>
                {asset.status === 'rejetée' && asset.review_reason && <p className="mt-2 text-xs text-[#831810]">Motif : {asset.review_reason}</p>}
                {asset.status === 'en_attente' && (
                  <ReviewControls
                    asset={asset}
                    rejecting={rejecting}
                    reason={reason}
                    setRejecting={setRejecting}
                    setReason={setReason}
                    approve={approve}
                  />
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onFile, kind }: { onFile: (file: File) => void; kind: Asset['kind'] }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#d8d5cf] bg-white px-6 py-16 text-center">
      <span className="text-2xl text-[#948f87]">▧</span>
      <h2 className="mt-4 text-sm font-semibold">La médiathèque est prête pour vos médias</h2>
      <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-[#88847c]">Ajoutez une photo réelle du véhicule, un logo de marque ou une piste audio. Les médias restent privés et doivent être approuvés avant utilisation.</p>
      <label className="mt-5 inline-flex cursor-pointer rounded-lg border border-[#dedbd5] px-4 py-2.5 text-xs font-semibold hover:bg-[#f8f7f4]">
        Choisir un premier fichier
        <input type="file" className="sr-only" accept={kind === 'audio' ? '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4' : 'image/jpeg,image/png,image/webp'} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onFile(file); event.currentTarget.value = ''; }} />
      </label>
    </div>
  );
}

function AssetPreview({ asset }: { asset: Asset }) {
  const statusClass = asset.status === 'validée' ? 'bg-[#e9f2eb] text-[#4e7656]' : asset.status === 'rejetée' ? 'bg-[#fae9e7] text-[#ac3c34]' : 'bg-[#fbf1dd] text-[#926b2a]';
  return (
    <div className="relative grid aspect-[1.55] place-items-center bg-[#e7ecee]">
      {asset.previewUrl && asset.kind === 'audio' ? (
        <audio src={asset.previewUrl} controls aria-label={`Écouter ${asset.variant ?? 'la piste audio'}`} className="w-full p-4" />
      ) : asset.previewUrl ? (
        <Image src={asset.previewUrl} alt={`${asset.make ?? ''} ${asset.model ?? ''} ${asset.color ?? ''}`.trim() || (asset.kind === 'logo' ? 'Logo de marque' : 'Média')} fill sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 33vw" unoptimized className="object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[#e7ecee]">
          <span className="text-4xl text-[#667c87]">{asset.kind === 'audio' ? '♫' : asset.kind === 'logo' ? 'R' : '▱'}</span>
        </div>
      )}
      <span className={`absolute right-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-semibold ${statusClass}`}>{asset.status === 'validée' ? 'Validé' : asset.status === 'rejetée' ? 'Refusé' : 'À valider'}</span>
    </div>
  );
}

function ReviewControls(props: {
  asset: Asset;
  rejecting: string;
  reason: string;
  setRejecting: (id: string) => void;
  setReason: (value: string) => void;
  approve: (asset: Asset, status: Asset['status']) => Promise<void>;
}) {
  const { asset, rejecting, reason, setRejecting, setReason, approve } = props;
  if (rejecting === asset.id) {
    return (
      <div className="mt-4 space-y-2">
        <label className="grid gap-1 text-xs font-semibold">
          Motif du refus
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} required className="rounded-md border border-[#d2cec6] p-2 font-normal" />
        </label>
        <div className="flex gap-2">
          <button onClick={() => void approve(asset, 'rejetée')} disabled={reason.trim().length < 3} className="rounded-md bg-[#831810] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Confirmer</button>
          <button onClick={() => { setRejecting(''); setReason(''); }} className="rounded-md border border-[#d2cec6] px-3 py-2 text-xs">Annuler</button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-4 flex gap-2">
      <button onClick={() => void approve(asset, 'validée')} className="flex-1 rounded-lg bg-[#253b4e] px-3 py-2 text-xs font-semibold text-white hover:bg-[#304b61]">Valider</button>
      <button onClick={() => { setRejecting(asset.id); setReason(''); }} className="rounded-lg border border-[#e8e5df] px-3 py-2 text-xs font-semibold text-[#756f67] hover:bg-[#f7f5f1]">Refuser</button>
    </div>
  );
}
