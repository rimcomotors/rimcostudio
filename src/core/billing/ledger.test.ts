import { describe, expect, it, vi } from 'vitest';
import { reserveGenerationCost, reserveKeyframeCost, reserveLlmCost, settleUsageCost } from './ledger';

function createAdminMock(options?: { insertedId?: string; ledger?: Record<string, unknown> | null; updateResult?: Record<string, unknown> | null; error?: Error | null }) {
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const query = {
    insert: vi.fn((row: Record<string, unknown>) => { inserted.push(row); return query; }),
    update: vi.fn((row: Record<string, unknown>) => { updates.push(row); return query; }),
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(async () => ({ data: { id: options?.insertedId ?? 'entry-1' }, error: options?.error ?? null })),
    maybeSingle: vi.fn(async () => ({ data: options?.ledger ?? options?.updateResult ?? null, error: options?.error ?? null })),
  };
  const admin = { from: vi.fn(() => query) };
  return { admin, query, inserted, updates };
}

describe('usage cost ledger', () => {
  it('reserves generation cost directly in the ledger without an RPC', async () => {
    const mock = createAdminMock();
    const entry = await reserveGenerationCost(mock.admin as never, {
      userId: 'user-1', versionId: 'version-1', modelId: 'model-1', department: 'Direction',
      seconds: 10, priceUsdPerSecond: 0.2, usdToEur: 0.9, eurToFcfa: 655.957, priceFcfa: 3711,
    });
    expect(entry.data).toBe('entry-1');
    expect(mock.admin.from).toHaveBeenCalledWith('usage_ledger');
    expect(mock.inserted[0]).toMatchObject({
      user_id: 'user-1', version_id: 'version-1', ai_model_id: 'model-1', kind: 'generation',
      seconds: 10, cost_usd: 2, cost_eur: 1.8, status: 'reserved', price_fcfa: 3711,
    });
  });

  it('reserves actual provider seconds while fixing the customer quote to the selected runtime', async () => {
    const mock = createAdminMock();
    await reserveGenerationCost(mock.admin as never, {
      userId: 'user-1', versionId: 'version-1', modelId: 'seedance', department: 'Direction',
      seconds: 32, billableSeconds: 10, priceUsdPerSecond: 0.2, usdToEur: 0.9, eurToFcfa: 655.957, priceFcfa: 1535,
    });
    expect(mock.inserted[0]).toMatchObject({ seconds: 32, cost_usd: 6.4, billable_seconds: 10, billable_cost_usd: 2, price_fcfa: 1535 });
  });

  it('records an LLM reservation as a zero customer price entry', async () => {
    const mock = createAdminMock();
    await reserveLlmCost(mock.admin as never, {
      userId: 'user-1', versionId: 'version-1', department: 'Direction', maxCostUsd: 0.5,
      usdToEur: 0.9, eurToFcfa: 655.957,
    });
    expect(mock.inserted[0]).toMatchObject({
      ai_model_id: null, kind: 'generation', seconds: 1, cost_usd: 0.5, cost_eur: 0.45,
      applied_fcfa_per_second: 0, price_fcfa: 0, status: 'reserved',
    });
  });

  it('reserves image-generation cost as an internal non-billable keyframe entry', async () => {
    const mock = createAdminMock();
    await reserveKeyframeCost(mock.admin as never, {
      userId: 'user-1', versionId: 'version-1', department: 'Direction', estimatedCostUsd: 0.08,
      usdToEur: 0.9, eurToFcfa: 655.957,
    });
    expect(mock.inserted[0]).toMatchObject({
      user_id: 'user-1', version_id: 'version-1', ai_model_id: null, kind: 'keyframe', seconds: 1,
      cost_usd: 0.08, price_fcfa: 0, status: 'reserved',
    });
    expect(Number(mock.inserted[0].cost_eur)).toBeCloseTo(0.072);
  });

  it('settles an entry once using an atomic reserved-status update and the 30% markup', async () => {
    const mock = createAdminMock({ ledger: { id: 'entry-1', status: 'reserved', seconds: 10, price_fcfa: 3711 } });
    mock.query.maybeSingle.mockResolvedValueOnce({ data: mock.admin ? { id: 'entry-1', status: 'reserved', seconds: 10, price_fcfa: 3711 } : null, error: null });
    mock.query.maybeSingle.mockResolvedValueOnce({ data: { id: 'entry-1' }, error: null });
    const result = await settleUsageCost(mock.admin as never, {
      entryId: 'entry-1', outcome: 'charged', actualCostUsd: 1, usdToEur: 0.9, eurToFcfa: 655.957,
    });
    expect(result.error).toBeNull();
    expect(mock.updates[0]).toMatchObject({ status: 'charged', cost_usd: 1, cost_eur: 0.9, price_fcfa: 768, applied_fcfa_per_second: 76.8 });
    expect(mock.query.eq).toHaveBeenCalledWith('status', 'reserved');
  });

  it('charges actual provider cost but retains the user price for the selected runtime', async () => {
    const ledger = { id: 'entry-1', status: 'reserved', seconds: 32, billable_seconds: 10, billable_cost_usd: 2, price_fcfa: 1535 };
    const mock = createAdminMock({ ledger });
    mock.query.maybeSingle.mockResolvedValueOnce({ data: ledger, error: null });
    mock.query.maybeSingle.mockResolvedValueOnce({ data: { id: 'entry-1' }, error: null });
    const result = await settleUsageCost(mock.admin as never, {
      entryId: 'entry-1', outcome: 'charged', actualCostUsd: 3.2, actualSeconds: 16, usdToEur: 0.9, eurToFcfa: 655.957,
    });
    expect(result.error).toBeNull();
    expect(mock.updates[0]).toMatchObject({ cost_usd: 3.2, seconds: 16, price_fcfa: 1535, applied_fcfa_per_second: 153.5 });
  });

  it('keeps the LLM ledger non-billable while settling its provider cost', async () => {
    const mock = createAdminMock({ ledger: { id: 'entry-1', status: 'reserved', seconds: 1, price_fcfa: 0 } });
    mock.query.maybeSingle.mockResolvedValueOnce({ data: { id: 'entry-1', status: 'reserved', seconds: 1, price_fcfa: 0 }, error: null });
    mock.query.maybeSingle.mockResolvedValueOnce({ data: { id: 'entry-1' }, error: null });
    const result = await settleUsageCost(mock.admin as never, {
      entryId: 'entry-1', outcome: 'charged', actualCostUsd: 0.5, usdToEur: 0.9, eurToFcfa: 655.957, billable: false,
    });
    expect(result.error).toBeNull();
    expect(mock.updates[0]).toMatchObject({ status: 'charged', cost_usd: 0.5, price_fcfa: 0, applied_fcfa_per_second: 0 });
  });

  it('reports a conflict when an entry was already settled', async () => {
    const mock = createAdminMock({ ledger: { id: 'entry-1', status: 'charged', seconds: 10, price_fcfa: 3711 } });
    const result = await settleUsageCost(mock.admin as never, {
      entryId: 'entry-1', outcome: 'released', actualCostUsd: 0, usdToEur: 0.9, eurToFcfa: 655.957,
    });
    expect(result.error).toBeInstanceOf(Error);
    expect(mock.updates).toHaveLength(0);
  });
});
