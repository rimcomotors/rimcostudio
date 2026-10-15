-- Prices must be checked against the current fal.ai model page before live use.
alter table public.ai_models add column if not exists pricing_verified_at timestamptz;

-- Freeze both the rate and estimated/settled cost on each generated shot.
alter table public.video_shots add column if not exists price_usd_per_second numeric(12,6);
alter table public.video_shots add column if not exists estimated_cost_usd numeric(12,6);
alter table public.video_shots add column if not exists actual_cost_usd numeric(12,6);

-- Serialize campaign reservations so simultaneous requests cannot exceed the cap.
create or replace function public.reserve_storyboard_comparison_budget(
  p_campaign_id uuid,
  p_amount_usd numeric,
  p_max_usd numeric
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  current_brief jsonb;
  current_reserved numeric;
  next_reserved numeric;
  old_durations jsonb;
begin
  if p_amount_usd <= 0 or p_max_usd <= 0 then
    raise exception 'Invalid storyboard budget amount';
  end if;
  select brief_json into current_brief from public.comparisons where id = p_campaign_id for update;
  if current_brief is null or current_brief->>'kind' <> 'storyboard_multiclip_comparison' then
    raise exception 'Storyboard comparison campaign not found';
  end if;
  current_reserved := coalesce((current_brief->>'reservedUsd')::numeric, 0);
  next_reserved := current_reserved + p_amount_usd;
  if next_reserved > p_max_usd then
    return null;
  end if;
  old_durations := coalesce(current_brief->'durations', '[]'::jsonb);
  update public.comparisons
    set brief_json = current_brief || jsonb_build_object(
      'reservedUsd', next_reserved,
      'durations', old_durations,
      'budgetUpdatedAt', now()
    )
    where id = p_campaign_id;
  return next_reserved;
end;
$$;
revoke all on function public.reserve_storyboard_comparison_budget(uuid,numeric,numeric) from public, anon, authenticated;
grant execute on function public.reserve_storyboard_comparison_budget(uuid,numeric,numeric) to service_role;
