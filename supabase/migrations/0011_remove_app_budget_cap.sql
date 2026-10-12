-- Fal owns the provider spending cap. Keep usage_ledger for cost reporting,
-- but remove application-level budget rejection from reserve and settle RPCs.
drop function if exists public.reserve_budget(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric);
drop function if exists public.reserve_llm_budget(uuid,uuid,numeric,numeric,numeric,numeric,text);
drop function if exists public.settle_budget(uuid,text,numeric,numeric,numeric,numeric);

create function public.reserve_budget(
  p_user_id uuid,p_version_id uuid,p_model_id uuid,p_seconds numeric,p_price_usd_second numeric,
  p_usd_to_eur numeric,p_eur_to_fcfa numeric,p_price_fcfa numeric,
  p_department text,p_applied_fcfa_second numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
declare entry_id uuid; estimated_usd numeric; estimated_eur numeric;
begin
  if p_seconds is null or p_seconds <= 0 or p_price_usd_second is null or p_price_usd_second < 0
    or p_usd_to_eur is null or p_usd_to_eur <= 0 or p_eur_to_fcfa is null or p_eur_to_fcfa <= 0
    or p_price_fcfa is null or p_price_fcfa < 0 or p_applied_fcfa_second is null or p_applied_fcfa_second < 0 then
    raise exception using errcode='22023', message='Paramètres de réservation invalides';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_user_id and p.is_active)
    or not exists(select 1 from public.video_versions vv join public.videos v on v.id=vv.video_id where vv.id=p_version_id and v.user_id=p_user_id)
    or not exists(select 1 from public.ai_models m where m.id=p_model_id and m.is_active) then
    raise exception using errcode='22023', message='Réservation impossible pour cette version';
  end if;
  estimated_usd := p_seconds * p_price_usd_second;
  estimated_eur := estimated_usd * p_usd_to_eur;
  insert into public.usage_ledger(version_id,user_id,department,ai_model_id,kind,seconds,cost_usd,cost_eur,cost_real_fcfa,applied_fcfa_per_second,price_fcfa,status)
  values(p_version_id,p_user_id,coalesce(p_department,''),p_model_id,'generation',p_seconds,estimated_usd,estimated_eur,estimated_eur*p_eur_to_fcfa,p_applied_fcfa_second,p_price_fcfa,'reserved') returning id into entry_id;
  return entry_id;
end $$;
revoke all on function public.reserve_budget(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,text,numeric) from public, anon, authenticated;
grant execute on function public.reserve_budget(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,text,numeric) to service_role;

create function public.reserve_llm_budget(
  p_user_id uuid,p_version_id uuid,p_max_cost_usd numeric,
  p_usd_to_eur numeric,p_eur_to_fcfa numeric,p_department text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare entry_id uuid; estimated_eur numeric;
begin
  if p_max_cost_usd is null or p_max_cost_usd <= 0 or p_usd_to_eur is null or p_usd_to_eur <= 0
    or p_eur_to_fcfa is null or p_eur_to_fcfa <= 0 then
    raise exception using errcode='22023', message='Paramètres de réservation LLM invalides';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_user_id and p.is_active)
    or not exists(select 1 from public.video_versions vv join public.videos v on v.id=vv.video_id where vv.id=p_version_id and v.user_id=p_user_id) then
    raise exception using errcode='22023', message='Réservation LLM impossible pour cette version';
  end if;
  estimated_eur := p_max_cost_usd * p_usd_to_eur;
  insert into public.usage_ledger(version_id,user_id,department,ai_model_id,kind,seconds,cost_usd,cost_eur,cost_real_fcfa,applied_fcfa_per_second,price_fcfa,status)
  values(p_version_id,p_user_id,coalesce(p_department,''),null,'generation',1,p_max_cost_usd,estimated_eur,estimated_eur*p_eur_to_fcfa,0,0,'reserved') returning id into entry_id;
  return entry_id;
end $$;
revoke all on function public.reserve_llm_budget(uuid,uuid,numeric,numeric,numeric,text) from public, anon, authenticated;
grant execute on function public.reserve_llm_budget(uuid,uuid,numeric,numeric,numeric,text) to service_role;

create function public.settle_budget(
  p_entry_id uuid,p_outcome text,p_actual_cost_usd numeric,p_usd_to_eur numeric,p_eur_to_fcfa numeric
) returns void language plpgsql security definer set search_path = '' as $$
declare entry public.usage_ledger%rowtype; final_eur numeric; final_usd numeric; client_price_fcfa numeric;
begin
  if p_outcome not in ('charged','released') or p_usd_to_eur is null or p_usd_to_eur <= 0
    or p_eur_to_fcfa is null or p_eur_to_fcfa <= 0
    or (p_outcome='charged' and (p_actual_cost_usd is null or p_actual_cost_usd < 0)) then
    raise exception using errcode='22023', message='Paramètres de clôture invalides';
  end if;
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
  client_price_fcfa := case when final_usd > 0 then ceil(final_eur * p_eur_to_fcfa * 1.30) else entry.price_fcfa end;
  update public.usage_ledger
    set status='charged', cost_usd=final_usd, cost_eur=final_eur,
        cost_real_fcfa=final_eur*p_eur_to_fcfa,
        price_fcfa=client_price_fcfa,
        applied_fcfa_per_second=case when entry.seconds > 0 then client_price_fcfa / entry.seconds else 0 end
    where id=p_entry_id;
end $$;
revoke all on function public.settle_budget(uuid,text,numeric,numeric,numeric) from public, anon, authenticated;
grant execute on function public.settle_budget(uuid,text,numeric,numeric,numeric) to service_role;

notify pgrst, 'reload schema';
