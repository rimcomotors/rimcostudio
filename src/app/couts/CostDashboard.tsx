'use client';

import { useEffect, useState } from 'react';
import { formatFcfa } from '@/core/pricing';

type CostRow = {
  version_id?: string | null;
  video_id?: string | null;
  title?: string;
  kind?: string;
  seconds?: number;
  price_fcfa?: number;
  status?: string;
  created_at?: string;
};

function csvCell(input: unknown): string {
  const value = String(input ?? '');
  const formulaSafe = /^[\s]*[=+@\-]/.test(value) ? `'${value}` : value;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

export function CostDashboard() {
  const [rows, setRows] = useState<CostRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/costs').then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Impossible de charger les montants facturés.');
      if (active) setRows(data.rows ?? []);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Une erreur est survenue.');
    });
    return () => { active = false; };
  }, []);

  if (error) return <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>;
  if (!rows) return <div aria-label="Chargement des coûts" className="h-48 animate-pulse rounded-2xl bg-[#e9e7e2]" />;

  const chargedRows = rows.filter((row) => row.status === 'charged' || row.status === 'ready');
  const billed = chargedRows.reduce((sum, row) => sum + Number(row.price_fcfa ?? 0), 0);
  const costRows = rows;

  function exportCsv() {
    const columns: (keyof CostRow)[] = ['title', 'version_id', 'kind', 'seconds', 'price_fcfa', 'status', 'created_at'];
    const csv = [columns.map(csvCell).join(';'), ...costRows.map((row) => columns.map((key) => csvCell(row[key])).join(';'))].join('\r\n');
    const blobUrl = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = 'rimco-facturation.csv';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  return <>
    <div className="mb-7 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-xl text-xs leading-5 text-[#716d66]">Retrouvez les montants facturés en FCFA et exportez l’historique.</p>
      <button onClick={exportCsv} className="rounded-lg border border-[#dedbd5] bg-[var(--surface)] px-4 py-2.5 text-xs font-semibold hover:bg-[#f4f2ee]">Exporter CSV</button>
    </div>
    <div className="mb-6 max-w-xl rounded-2xl border border-black/[.055] bg-[var(--surface)] p-5">
      <p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#716d66]">Total facturé</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{formatFcfa(billed)}</p>
      <p className="mt-1 text-xs text-[#716d66]">{chargedRows.length} opération{chargedRows.length === 1 ? '' : 's'} facturée{chargedRows.length === 1 ? '' : 's'}</p>
    </div>
    <div className="overflow-x-auto rounded-2xl border border-black/[.055] bg-[var(--surface)]">
      <table className="w-full min-w-[560px] border-collapse text-left text-xs">
        <thead className="border-b border-black/[.055] bg-[#f8f7f4]"><tr>{['Vidéo', 'Type', 'Durée', 'Montant facturé', 'État'].map((item) => <th key={item} className="px-4 py-3 text-[9px] font-bold uppercase tracking-[.14em] text-[#716d66]">{item}</th>)}</tr></thead>
        <tbody className="divide-y divide-black/[.04]">{rows.map((row, index) => <tr key={`${row.version_id ?? row.video_id}-${index}`}>
          <td className="px-4 py-4 font-medium">{row.title ?? row.video_id ?? row.version_id ?? 'Vidéo'}<span className="ml-2 text-[10px] text-[#716d66]">{row.created_at ? new Date(row.created_at).toLocaleDateString('fr-FR') : ''}</span></td>
          <td className="px-4 py-4 text-[#716d66]">{row.kind === 'generation' ? 'Génération' : row.kind === 'postprod' ? 'Post-production' : 'Vidéo'}</td>
          <td className="px-4 py-4 text-[#716d66]">{row.seconds ?? 5} s</td>
          <td className="px-4 py-4 font-semibold">{row.status === 'released' ? '—' : formatFcfa(row.price_fcfa ?? 0)}</td>
          <td className="px-4 py-4 text-[#716d66]">{row.status === 'reserved' ? 'En cours' : row.status === 'released' ? 'Annulée' : row.status === 'charged' || row.status === 'ready' ? 'Facturée' : row.status ?? '—'}</td>
        </tr>)}</tbody>
      </table>
      {rows.length === 0 && <p className="px-6 py-12 text-center text-xs text-[#716d66]">Aucune opération facturée pour le moment.</p>}
    </div>
  </>;
}
