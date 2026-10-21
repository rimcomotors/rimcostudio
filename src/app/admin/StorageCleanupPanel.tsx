'use client';

import { useState } from 'react';

type Scan = { versionIds: string[]; versions: number; files: number; estimatedBytes: number; unknownFiles: number; hasMore: boolean };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

export function StorageCleanupPanel() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function post<T>(body: Record<string, unknown>) {
    const response = await fetch('/api/admin/storage/cleanup-intermediates', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? 'Le nettoyage du stockage a échoué.');
    return data as T;
  }

  async function analyze() {
    setError(''); setMessage(''); setBusy(true);
    try { setScan(await post<Scan>({ action: 'preview' })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Impossible d’analyser le stockage.'); }
    finally { setBusy(false); }
  }

  async function cleanup() {
    setError(''); setMessage(''); setBusy(true);
    let current = scan;
    let deletedFiles = 0;
    let reclaimedBytes = 0;
    try {
      while (current?.versionIds.length) {
        const result = await post<{ deletedFiles: number; estimatedBytes: number }>({ action: 'cleanup', versionIds: current.versionIds });
        deletedFiles += result.deletedFiles;
        reclaimedBytes += result.estimatedBytes;
        setMessage(`${deletedFiles} clip(s) supprimé(s), environ ${formatBytes(reclaimedBytes)} libérés…`);
        const next = await post<Scan>({ action: 'preview' });
        if (next.versionIds.length && result.deletedFiles === 0) throw new Error('Le nettoyage n’avance plus; les références restantes sont conservées pour vérification.');
        current = next;
        setScan(next);
      }
      setMessage(`${deletedFiles} clip(s) intermédiaire(s) supprimé(s), environ ${formatBytes(reclaimedBytes)} libérés. Les MP4 finaux, les images-clés, le logo et les photos véhicule sont conservés.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Le nettoyage s’est arrêté.');
    } finally { setBusy(false); }
  }

  return <section className="max-w-3xl rounded-2xl border border-black/[.055] bg-[var(--surface)] p-6">
    <p className="text-[10px] font-semibold uppercase tracking-[.16em] text-[#a42e26]">Stockage Supabase</p>
    <h2 className="mt-2 text-lg font-semibold">Nettoyer les clips intermédiaires</h2>
    <p className="mt-2 text-sm leading-6 text-[#716d66]">Les clips bruts des versions terminées sont conservés après la création du MP4 final. L’analyse cible uniquement ces fichiers des versions prêtes; les vidéos finales, images-clés, photos validées et le logo ne sont jamais supprimés.</p>
    {scan && <p className="mt-4 rounded-lg bg-[#f7f5f1] p-3 text-sm" role="status">Prochain lot : {scan.files} fichier(s), {formatBytes(scan.estimatedBytes)} estimés sur {scan.versions} version(s){scan.unknownFiles ? ` · taille inconnue pour ${scan.unknownFiles} fichier(s)` : ''}{scan.hasMore ? ' · d’autres lots suivront' : ''}.</p>}
    {message && <p className="mt-4 rounded-lg bg-[#edf4ee] p-3 text-sm text-[#456c4c]" role="status">{message}</p>}
    {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
    <div className="mt-5 flex flex-wrap gap-3">
      <button type="button" disabled={busy} onClick={() => void analyze()} className="min-h-11 rounded-lg border border-[#e2dfd9] px-4 py-2 text-xs font-semibold disabled:opacity-50">{busy ? 'Analyse…' : 'Analyser le prochain lot'}</button>
      {scan && scan.versionIds.length > 0 && <button type="button" disabled={busy} onClick={() => void cleanup()} className="min-h-11 rounded-lg bg-[#253b4e] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? 'Nettoyage…' : 'Nettoyer les clips analysés et les lots suivants'}</button>}
    </div>
  </section>;
}
