import { calculateClientPriceFcfa } from '@/core/pricing';

export type UsageLedgerRow = {
  kind?: string | null;
  ai_model_id?: string | null;
  seconds?: number | string | null;
  cost_usd?: number | string | null;
  billable_cost_usd?: number | string | null;
  price_fcfa?: number | string | null;
  status?: string | null;
};

export type AggregatedGenerationCost = {
  costUsd: number;
  priceFcfa: number;
  seconds: number;
  status: 'reserved' | 'charged';
};

/**
 * Combines the LLM brief reservation and the Fal video reservation into the
 * single amount shown to the team. Released reservations never appear in the
 * customer total; the provider estimate is converted once and the 30% markup
 * is applied once to the combined amount.
 */
export function aggregateGenerationCost(
  rows: UsageLedgerRow[],
  usdToEur: number,
  eurToFcfa: number,
): AggregatedGenerationCost | null {
  const activeRows = rows.filter((row) => row.kind === 'generation' && row.status !== 'released');
  if (!activeRows.length) return null;

  const costUsd = activeRows.reduce((sum, row) => sum + Math.max(0, Number(row.cost_usd ?? 0)), 0);
  const storedPrice = activeRows.reduce((sum, row) => sum + Math.max(0, Number(row.price_fcfa ?? 0)), 0);
  const billableCostUsd = activeRows.reduce((sum, row) => sum + Math.max(0, Number(row.billable_cost_usd ?? row.cost_usd ?? 0)), 0);
  const priceFcfa = billableCostUsd > 0 ? calculateClientPriceFcfa(billableCostUsd, usdToEur, eurToFcfa) : storedPrice;
  const videoRows = activeRows.filter((row) => row.ai_model_id);
  const durationRows = videoRows.length ? videoRows : activeRows;
  const seconds = Math.max(...durationRows.map((row) => Math.max(0, Number(row.seconds ?? 0))), 0);
  const status = activeRows.some((row) => row.status === 'reserved') ? 'reserved' : 'charged';

  return { costUsd, priceFcfa, seconds, status };
}
