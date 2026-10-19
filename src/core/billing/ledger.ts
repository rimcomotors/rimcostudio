import type { createStorageAdminClient } from '@/core/storage/supabase';

type AdminClient = ReturnType<typeof createStorageAdminClient>;
type Outcome = 'charged' | 'released';

type ReservationResult = { data: string | null; error: Error | null };

function ensurePositiveFinite(value: number, name: string, allowZero = false) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`Valeur de suivi de coût invalide : ${name}.`);
  }
}

function normalizeError(error: unknown): Error | null {
  if (!error) return null;
  return error instanceof Error ? error : new Error('Échec de l’écriture du journal de coûts.');
}

export async function reserveGenerationCost(admin: AdminClient, input: {
  userId: string;
  versionId: string;
  modelId: string;
  department: string;
  seconds: number;
  billableSeconds?: number;
  priceUsdPerSecond: number;
  usdToEur: number;
  eurToFcfa: number;
  priceFcfa: number;
}): Promise<ReservationResult> {
  ensurePositiveFinite(input.seconds, 'durée');
  ensurePositiveFinite(input.priceUsdPerSecond, 'tarif fournisseur', true);
  ensurePositiveFinite(input.usdToEur, 'taux USD/EUR');
  ensurePositiveFinite(input.eurToFcfa, 'taux EUR/FCFA');
  ensurePositiveFinite(input.priceFcfa, 'prix facturé', true);
  const costUsd = input.seconds * input.priceUsdPerSecond;
  const billableSeconds = input.billableSeconds ?? input.seconds;
  ensurePositiveFinite(billableSeconds, 'durée facturable', true);
  if (billableSeconds > input.seconds) throw new Error('La durée facturable ne peut pas dépasser la durée réservée.');
  const billableCostUsd = billableSeconds * input.priceUsdPerSecond;
  const costEur = costUsd * input.usdToEur;
  const { data, error } = await admin.from('usage_ledger').insert({
    version_id: input.versionId,
    user_id: input.userId,
    department: input.department,
    ai_model_id: input.modelId,
    kind: 'generation',
    seconds: input.seconds,
    cost_usd: costUsd,
    cost_eur: costEur,
    cost_real_fcfa: costEur * input.eurToFcfa,
    billable_seconds: billableSeconds,
    billable_cost_usd: billableCostUsd,
    applied_fcfa_per_second: billableSeconds > 0 ? input.priceFcfa / billableSeconds : 0,
    price_fcfa: input.priceFcfa,
    status: 'reserved',
  }).select('id').single();
  return { data: data?.id ?? null, error: normalizeError(error) };
}

export async function reserveLlmCost(admin: AdminClient, input: {
  userId: string;
  versionId?: string;
  department: string;
  maxCostUsd: number;
  usdToEur: number;
  eurToFcfa: number;
}): Promise<ReservationResult> {
  ensurePositiveFinite(input.maxCostUsd, 'estimation LLM');
  ensurePositiveFinite(input.usdToEur, 'taux USD/EUR');
  ensurePositiveFinite(input.eurToFcfa, 'taux EUR/FCFA');
  const costEur = input.maxCostUsd * input.usdToEur;
  const { data, error } = await admin.from('usage_ledger').insert({
    version_id: input.versionId ?? null,
    user_id: input.userId,
    department: input.department,
    ai_model_id: null,
    kind: 'generation',
    seconds: 1,
    cost_usd: input.maxCostUsd,
    cost_eur: costEur,
    cost_real_fcfa: costEur * input.eurToFcfa,
    applied_fcfa_per_second: 0,
    price_fcfa: 0,
    status: 'reserved',
  }).select('id').single();
  return { data: data?.id ?? null, error: normalizeError(error) };
}

export async function reserveKeyframeCost(admin: AdminClient, input: {
  userId: string;
  versionId: string;
  department: string;
  estimatedCostUsd: number;
  usdToEur: number;
  eurToFcfa: number;
}): Promise<ReservationResult> {
  ensurePositiveFinite(input.estimatedCostUsd, 'estimation de l’image-clé');
  ensurePositiveFinite(input.usdToEur, 'taux USD/EUR');
  ensurePositiveFinite(input.eurToFcfa, 'taux EUR/FCFA');
  const costEur = input.estimatedCostUsd * input.usdToEur;
  const { data, error } = await admin.from('usage_ledger').insert({
    version_id: input.versionId, user_id: input.userId, department: input.department,
    ai_model_id: null, kind: 'keyframe', seconds: 1,
    cost_usd: input.estimatedCostUsd, cost_eur: costEur, cost_real_fcfa: costEur * input.eurToFcfa,
    applied_fcfa_per_second: 0, price_fcfa: 0, status: 'reserved',
  }).select('id').single();
  return { data: data?.id ?? null, error: normalizeError(error) };
}

export async function settleUsageCost(admin: AdminClient, input: {
  entryId: string;
  outcome: Outcome;
  actualCostUsd: number;
  actualSeconds?: number;
  usdToEur: number;
  eurToFcfa: number;
  /** LLM preparation is tracked for operations but is included in the video total at read time. */
  billable?: boolean;
}): Promise<{ error: Error | null }> {
  ensurePositiveFinite(input.usdToEur, 'taux USD/EUR');
  ensurePositiveFinite(input.eurToFcfa, 'taux EUR/FCFA');
  if (input.outcome === 'charged') ensurePositiveFinite(input.actualCostUsd, 'coût fournisseur', true);
  if (input.actualSeconds !== undefined) ensurePositiveFinite(input.actualSeconds, 'durée réellement générée', true);

  const { data: entry, error: readError } = await admin.from('usage_ledger')
    .select('id,status,seconds,price_fcfa,billable_seconds,billable_cost_usd')
    .eq('id', input.entryId)
    .maybeSingle();
  if (readError) return { error: normalizeError(readError) };
  if (!entry || entry.status !== 'reserved') return { error: new Error('Réservation introuvable ou déjà clôturée.') };

  const patch: Record<string, number | string> = { status: input.outcome };
  if (input.outcome === 'charged') {
    const costEur = input.actualCostUsd * input.usdToEur;
    const priceFcfa = input.billable === false ? 0 : Number(entry.price_fcfa ?? 0);
    patch.cost_usd = input.actualCostUsd;
    if (input.actualSeconds !== undefined) patch.seconds = input.actualSeconds;
    patch.cost_eur = costEur;
    patch.cost_real_fcfa = costEur * input.eurToFcfa;
    patch.price_fcfa = priceFcfa;
    const billableSeconds = Number(entry.billable_seconds ?? entry.seconds);
    patch.applied_fcfa_per_second = billableSeconds > 0 ? priceFcfa / billableSeconds : 0;
  }

  const { data, error } = await admin.from('usage_ledger').update(patch)
    .eq('id', input.entryId)
    .eq('status', 'reserved')
    .select('id')
    .maybeSingle();
  if (error) return { error: normalizeError(error) };
  return data ? { error: null } : { error: new Error('Réservation déjà clôturée pendant son traitement.') };
}
