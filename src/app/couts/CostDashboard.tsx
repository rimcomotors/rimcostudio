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
  cost_real_fcfa?: number;
  cost_eur?: number;
  margin_fcfa?: number;
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
  const [month, setMonth] = useState('');

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
  const monthKey = (value?: string) => value ? value.slice(0, 7) : '';
  const monthTotals = new Map<string, { total: number; count: number }>();
  for (const row of chargedRows) {
    const key = monthKey(row.created_at);
    if (!key) continue;
    const current = monthTotals.get(key) ?? { total: 0, count: 0 };
    monthTotals.set(key, { total: current.total + Number(row.price_fcfa ?? 0), count: current.count + 1 });
  }
  const availableMonths = [...monthTotals.keys()].sort((a, b) => b.localeCompare(a));
  const selectedRows = rows.filter((row) => !month || monthKey(row.created_at) === month);
  const selectedChargedRows = chargedRows.filter((row) => !month || monthKey(row.created_at) === month);
  const billed = selectedChargedRows.reduce((sum, row) => sum + Number(row.price_fcfa ?? 0), 0);

  function exportCsv() {
    const columns: (keyof CostRow)[] = ['title', 'version_id', 'kind', 'seconds', 'price_fcfa', 'cost_real_fcfa', 'cost_eur', 'margin_fcfa', 'status', 'created_at'];
    const csv = [columns.map(csvCell).join(';'), ...selectedRows.map((row) => columns.map((key) => csvCell(row[key])).join(';'))].join('\r\n');
    const blobUrl = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `rimco-facturation${month ? `-${month}` : ''}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  return <>
    <div className="mb-7 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-4"><p className="max-w-xl text-xs leading-5 text-[#716d66]">Retrouvez les montants facturés en FCFA et exportez l’historique.</p><label className="flex items-center gap-2 text-xs font-semibold">Mois<select value={month} onChange={(event) => setMonth(event.target.value)} className="rounded-lg border border-[#dedbd5] bg-white px-3 py-2.5 text-xs font-normal"><option value="">Tous les mois</option>{availableMonths.map((key) => <option key={key} value={key}>{new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`))}</option>)}</select></label></div>
      <button onClick={exportCsv} className="rounded-lg border border-[#dedbd5] bg-[var(--surface)] px-4 py-2.5 text-xs font-semibold hover:bg-[#f4f2ee]">Exporter CSV</button>
    </div>
    <div className="mb-6 max-w-xl rounded-2xl border border-black/[.055] bg-[var(--surface)] p-5">
      <p className="text-[10px] font-bold uppercase tracking-[.15em] text-[#716d66]">Total facturé</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{formatFcfa(billed)}</p>
      <p className="mt-1 text-xs text-[#716d66]">{selectedChargedRows.length} opération{selectedChargedRows.length === 1 ? '' : 's'} facturée{selectedChargedRows.length === 1 ? '' : 's'}{month ? ` · ${new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}` : ' · période sélectionnée'}</p>
    </div>
    {availableMonths.length > 0 && <section aria-label="Récapitulatif mensuel" className="mb-6"><h2 className="mb-3 text-xs font-semibold">Récapitulatif mensuel</h2><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{availableMonths.map((key) => { const item = monthTotals.get(key)!; return <button type="button" key={key} onClick={() => setMonth(key)} aria-pressed={month === key} className={`rounded-xl border p-4 text-left ${month === key ? 'border-[#c51e1c] bg-[#fcf4f2]' : 'border-black/[.055] bg-white'}`}><span className="block text-[10px] font-semibold capitalize text-[#716d66]">{new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`))}</span><b className="mt-2 block text-base">{formatFcfa(item.total)}</b><span className="mt-1 block text-[10px] text-[#716d66]">{item.count} opération{item.count === 1 ? '' : 's'}</span></button>; })}</div></section>}
    <div className="overflow-x-auto rounded-2xl border border-black/[.055] bg-[var(--surface)]">
      <table className="w-full min-w-[720px] border-collapse text-left text-xs">
        <thead className="border-b border-black/[.055] bg-[#f8f7f4]"><tr>{['Vidéo', 'Date de génération', 'Type', 'Durée', 'Montant facturé', 'Coût réel', 'Marge', 'État'].map((item) => <th key={item} className="px-4 py-3 text-[9px] font-bold uppercase tracking-[.14em] text-[#716d66]">{item}</th>)}</tr></thead>
        <tbody className="divide-y divide-black/[.04]">{selectedRows.map((row, index) => <tr key={`${row.version_id ?? row.video_id}-${index}`}>
          <td className="px-4 py-4 font-medium">{row.title ?? row.video_id ?? row.version_id ?? 'Vidéo'}</td>
          <td className="px-4 py-4 text-[#716d66]">{row.created_at ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(row.created_at)) : '—'}</td>
          <td className="px-4 py-4 text-[#716d66]">{row.kind === 'generation' ? 'Génération' : row.kind === 'postprod' ? 'Post-production' : 'Vidéo'}</td>
          <td className="px-4 py-4 text-[#716d66]">{row.seconds ?? 5} s</td>
          <td className="px-4 py-4 font-semibold">{row.status === 'released' ? '—' : formatFcfa(row.price_fcfa ?? 0)}</td>
          <td className="px-4 py-4 text-[#716d66]">{row.status === 'reserved' ? 'En cours' : formatFcfa(row.cost_real_fcfa ?? 0)}{typeof row.cost_eur === 'number' && row.status !== 'reserved' ? <small className="ml-1 text-[9px]">({row.cost_eur.toFixed(2)} €)</small> : null}</td>
          <td className="px-4 py-4 text-[#716d66]">{row.status === 'reserved' ? 'En cours' : formatFcfa(row.margin_fcfa ?? ((row.price_fcfa ?? 0) - (row.cost_real_fcfa ?? 0)))}</td>
          <td className="px-4 py-4 text-[#716d66]">{row.status === 'reserved' ? 'En cours' : row.status === 'released' ? 'Annulée' : row.status === 'charged' || row.status === 'ready' ? 'Facturée' : row.status ?? '—'}</td>
        </tr>)}</tbody>
      </table>
      {selectedRows.length === 0 && <p className="px-6 py-12 text-center text-xs text-[#716d66]">Aucune opération facturée pour cette période.</p>}
    </div>
  </>;
}
