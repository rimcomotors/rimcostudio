-- Apply a 30% markup to the provider charge when a generation reservation is settled.
-- This changes the customer-facing price only; provider costs and the budget cap remain intact.
create or replace function public.settle_budget(p_entry_id uuid,p_outcome text,p_actual_cost_usd numeric,p_usd_to_eur numeric,p_eur_to_fcfa numeric,p_cap_eur numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare
  entry public.usage_ledger%rowtype;
  final_eur numeric;
  final_usd numeric;
  client_price_fcfa numeric;
begin
  if p_outcome not in ('charged','released') or p_cap_eur is null or p_cap_eur < 0
    or p_usd_to_eur is null or p_usd_to_eur <= 0 or p_eur_to_fcfa is null or p_eur_to_fcfa <= 0
    or (p_outcome='charged' and (p_actual_cost_usd is null or p_actual_cost_usd < 0)) then
    raise exception using errcode='22023', message='Paramètres de clôture invalides';
  end if;
  perform pg_advisory_xact_lock(hashtext('rimco_budget_cap_eur'));
  select * into entry from public.usage_ledger where id=p_entry_id for update;
  if not found or entry.status <> 'reserved' then
    raise exception using errcode='P0001', message='Réservation introuvable ou déjà clôturée';
  end if;
  if p_outcome='released' then
    update public.usage_ledger set status='released' where id=p_entry_id;
    return;
  end if;
  final_usd := p_actual_cost_usd;
  final_eur := final_usd * p_usd_to_eur;
  if coalesce((select sum(l.cost_eur) from public.usage_ledger l where l.status in ('reserved','charged') and l.id<>p_entry_id),0)+final_eur > p_cap_eur then
    raise exception using errcode='P0001', message='Le coût réel dépasserait le plafond autorisé';
  end if;
  client_price_fcfa := case when final_usd > 0 then ceil(final_eur * p_eur_to_fcfa * 1.30) else entry.price_fcfa end;
  update public.usage_ledger
    set status='charged', cost_usd=final_usd, cost_eur=final_eur,
        cost_real_fcfa=final_eur*p_eur_to_fcfa,
        price_fcfa=client_price_fcfa,
        applied_fcfa_per_second=case when entry.seconds > 0 then client_price_fcfa / entry.seconds else 0 end
    where id=p_entry_id;
end $$;
revoke all on function public.settle_budget(uuid,text,numeric,numeric,numeric,numeric) from public, anon, authenticated;
grant execute on function public.settle_budget(uuid,text,numeric,numeric,numeric,numeric) to service_role;
