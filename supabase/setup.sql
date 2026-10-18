-- RIMCO Studio initial schema. Safe to apply repeatedly on a clean or existing V1 database.
create extension if not exists pgcrypto;

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  primary_color text not null default '#c51e1c', secondary_color text not null default '#831810',
  created_at timestamptz not null default now()
);
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '', role text not null default 'collaborateur' check (role in ('collaborateur','valideur','admin')),
  department text not null default '', brand_id uuid references public.brands(id),
  is_active boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.pricing_settings (
  id uuid primary key default gen_random_uuid(), brand_id uuid not null unique references public.brands(id) on delete cascade,
  grid_fcfa_per_second_standard numeric(12,2) not null default 460 check (grid_fcfa_per_second_standard >= 0),
  grid_fcfa_per_second_premium numeric(12,2) not null default 700 check (grid_fcfa_per_second_premium >= 0),
  updated_by uuid references public.profiles(id) on delete set null, updated_at timestamptz not null default now()
);
create table if not exists public.ai_models (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  tier text not null check (tier in ('standard','premium','test')), fal_endpoint_id text not null,
  adapter_family text not null, mode text not null check (mode in ('image_to_video','text_to_video')),
  price_usd_per_second numeric(12,6) not null check (price_usd_per_second >= 0),
  allowed_durations integer[] not null default '{5}', allowed_formats text[] not null default '{16:9,9:16,1:1,4:5}',
  is_active boolean not null default false, is_default boolean not null default false,
  constraint active_model_has_real_endpoint check (not is_active or fal_endpoint_id not like 'TODO%')
);
create unique index if not exists ai_models_one_default_per_tier on public.ai_models(tier) where is_default;
create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(), brand_id uuid references public.brands(id) on delete cascade,
  kind text not null check (kind in ('vehicle','logo','audio')), make text, model text, color text,
  angle text, variant text, path text not null, status text not null default 'en_attente' check(status in ('en_attente','validée','rejetée')),
  review_reason text,
  created_by uuid references public.profiles(id) on delete set null, created_at timestamptz not null default now()
);
alter table public.assets add column if not exists review_reason text;
create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id),
  brand_id uuid references public.brands(id), title text not null default 'Nouvelle vidéo', department text not null default '',
  status text not null default 'draft' check(status in ('draft','generating','ready','review','approved','rejected','failed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.video_versions (
  id uuid primary key default gen_random_uuid(), video_id uuid not null references public.videos(id) on delete cascade,
  number integer not null check(number > 0), brief_json jsonb not null default '{}', generated_prompt text not null default '',
  ai_model_id uuid references public.ai_models(id), provider_request_id text,
  status text not null default 'queued' check(status in ('queued','generating','postprocessing','ready','failed')),
  raw_path text, final_path text, overlay_variant text, audio_asset_id uuid references public.assets(id),
  generation_seconds integer not null default 5 check(generation_seconds = 5), error_message text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(video_id,number)
);
create table if not exists public.validations (
  id uuid primary key default gen_random_uuid(), video_id uuid not null references public.videos(id) on delete cascade,
  version_id uuid not null references public.video_versions(id) on delete cascade,
  submitted_by uuid not null references public.profiles(id), reviewed_by uuid references public.profiles(id),
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  reason text, created_at timestamptz not null default now(), reviewed_at timestamptz,
  constraint rejected_validation_requires_reason check(status <> 'rejected' or length(trim(coalesce(reason,''))) > 0)
);
create table if not exists public.usage_ledger (
  id uuid primary key default gen_random_uuid(), version_id uuid references public.video_versions(id) on delete set null,
  user_id uuid not null references public.profiles(id), department text not null default '', ai_model_id uuid references public.ai_models(id),
  kind text not null check(kind in ('generation','postprod')), seconds numeric(10,3) not null check(seconds > 0),
  cost_usd numeric(14,6) not null default 0 check(cost_usd >= 0), cost_eur numeric(14,6) not null default 0 check(cost_eur >= 0),
  cost_real_fcfa numeric(14,2) not null default 0 check(cost_real_fcfa >= 0),
  applied_fcfa_per_second numeric(12,2) not null check(applied_fcfa_per_second >= 0),
  price_fcfa numeric(14,2) not null check(price_fcfa >= 0),
  status text not null check(status in ('reserved','charged','released')), created_at timestamptz not null default now()
);
create index if not exists usage_ledger_budget_idx on public.usage_ledger(status) where status in ('reserved','charged');
create table if not exists public.comparisons (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id),
  brief_json jsonb not null, created_at timestamptz not null default now()
);

-- SECURITY DEFINER helpers have a fixed search_path and are not exposed as user-callable APIs.
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.is_active)
$$;
create or replace function public.create_profile_for_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
declare first_brand uuid; new_role text;
begin
  perform pg_advisory_xact_lock(hashtext('rimco_first_admin'));
  select b.id into first_brand from public.brands b order by b.created_at limit 1;
  new_role := case when exists(select 1 from public.profiles p where p.role = 'admin') then 'collaborateur' else 'admin' end;
  insert into public.profiles(id,name,role,brand_id) values(new.id,coalesce(new.raw_user_meta_data->>'name',''),new_role,first_brand);
  return new;
end $$;
revoke all on function public.create_profile_for_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users for each row execute function public.create_profile_for_new_user();

-- Serialize role changes/deletes that could remove the last active administrator.
create or replace function public.guard_last_active_admin() returns trigger language plpgsql security definer set search_path = '' as $$
declare active_admins integer;
begin
  if tg_op='DELETE' then
    if old.role='admin' and old.is_active then
      perform pg_advisory_xact_lock(hashtext('rimco_active_admin_roster'));
      select count(*) into active_admins from public.profiles p where p.role='admin' and p.is_active and p.id<>old.id;
      if active_admins=0 then
        raise exception using errcode='P0001', message='Impossible de supprimer le dernier administrateur actif';
      end if;
    end if;
    return old;
  end if;
  if old.role='admin' and old.is_active and (new.role<>'admin' or not new.is_active) then
    perform pg_advisory_xact_lock(hashtext('rimco_active_admin_roster'));
    select count(*) into active_admins from public.profiles p where p.role='admin' and p.is_active and p.id<>old.id;
    if active_admins=0 then
      raise exception using errcode='P0001', message='Impossible de désactiver ou rétrograder le dernier administrateur actif';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_last_active_admin() from public, anon, authenticated;
drop trigger if exists guard_last_active_admin_update on public.profiles;
drop trigger if exists guard_last_active_admin_delete on public.profiles;
create trigger guard_last_active_admin_update before update of role,is_active on public.profiles for each row execute function public.guard_last_active_admin();
create trigger guard_last_active_admin_delete before delete on public.profiles for each row execute function public.guard_last_active_admin();

-- Only service_role may reserve budget. Advisory transaction lock serializes concurrent reservations;
-- the authenticated caller identity and all pricing inputs are supplied by trusted server code.
create or replace function public.reserve_budget(
  p_user_id uuid,p_version_id uuid,p_model_id uuid,p_seconds numeric,p_price_usd_second numeric,
  p_usd_to_eur numeric,p_eur_to_fcfa numeric,p_price_fcfa numeric,p_cap_eur numeric,
  p_department text,p_applied_fcfa_second numeric
) returns uuid language plpgsql security definer set search_path = '' as $$
declare entry_id uuid; estimated_usd numeric; estimated_eur numeric;
begin
  if p_seconds is null or p_seconds <= 0 or p_price_usd_second is null or p_price_usd_second < 0
    or p_usd_to_eur is null or p_usd_to_eur <= 0 or p_eur_to_fcfa is null or p_eur_to_fcfa <= 0
    or p_cap_eur is null or p_cap_eur < 0 or p_price_fcfa is null or p_price_fcfa < 0
    or p_applied_fcfa_second is null or p_applied_fcfa_second < 0 then
    raise exception using errcode='22023', message='Paramètres de réservation invalides';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_user_id and p.is_active)
    or not exists(select 1 from public.video_versions vv join public.videos v on v.id=vv.video_id where vv.id=p_version_id and v.user_id=p_user_id)
    or not exists(select 1 from public.ai_models m where m.id=p_model_id and m.is_active) then
    raise exception using errcode='22023', message='Réservation impossible pour cette version';
  end if;
  estimated_usd := p_seconds * p_price_usd_second;
  estimated_eur := estimated_usd * p_usd_to_eur;
  perform pg_advisory_xact_lock(hashtext('rimco_budget_cap_eur'));
  if coalesce((select sum(l.cost_eur) from public.usage_ledger l where l.status in ('reserved','charged')),0) + estimated_eur > p_cap_eur then
    raise exception using errcode='P0001', message='Plafond de coût réel dépassé';
  end if;
  insert into public.usage_ledger(version_id,user_id,department,ai_model_id,kind,seconds,cost_usd,cost_eur,cost_real_fcfa,applied_fcfa_per_second,price_fcfa,status)
  values(p_version_id,p_user_id,coalesce(p_department,''),p_model_id,'generation',p_seconds,estimated_usd,estimated_eur,estimated_eur*p_eur_to_fcfa,p_applied_fcfa_second,p_price_fcfa,'reserved') returning id into entry_id;
  return entry_id;
end $$;
revoke all on function public.reserve_budget(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric) from public, anon, authenticated;
grant execute on function public.reserve_budget(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric) to service_role;

-- Finalize a reservation exactly once. Actual charges cannot silently push the account over its cap.
create or replace function public.settle_budget(p_entry_id uuid,p_outcome text,p_actual_cost_usd numeric,p_usd_to_eur numeric,p_eur_to_fcfa numeric,p_cap_eur numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare entry public.usage_ledger%rowtype; final_eur numeric; final_usd numeric;
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
  update public.usage_ledger set status='charged',cost_usd=final_usd,cost_eur=final_eur,cost_real_fcfa=final_eur*p_eur_to_fcfa where id=p_entry_id;
end $$;
revoke all on function public.settle_budget(uuid,text,numeric,numeric,numeric,numeric) from public, anon, authenticated;
grant execute on function public.settle_budget(uuid,text,numeric,numeric,numeric,numeric) to service_role;

-- A pending item is visible to active validators for review. Admins manage all state;
-- ordinary clients cannot write processing state, ledger rows, or role assignments.
do $$ declare t text; begin foreach t in array array['brands','pricing_settings','profiles','ai_models','assets','videos','video_versions','validations','usage_ledger','comparisons'] loop execute format('alter table public.%I enable row level security',t); end loop; end $$;
drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin on public.profiles for select to authenticated using(id=auth.uid() or public.is_admin());
drop policy if exists profiles_admin_manage on public.profiles;
create policy profiles_admin_manage on public.profiles for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists brands_read_authenticated on public.brands;
create policy brands_read_authenticated on public.brands for select to authenticated using(true);
drop policy if exists brands_admin_manage on public.brands;
create policy brands_admin_manage on public.brands for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists pricing_read_authenticated on public.pricing_settings;
create policy pricing_read_authenticated on public.pricing_settings for select to authenticated using(true);
drop policy if exists pricing_admin_manage on public.pricing_settings;
create policy pricing_admin_manage on public.pricing_settings for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists models_read_authenticated on public.ai_models;
drop policy if exists models_admin_read on public.ai_models;
create policy models_admin_read on public.ai_models for select to authenticated using(public.is_admin());
drop policy if exists models_admin_manage on public.ai_models;
create policy models_admin_manage on public.ai_models for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists assets_read on public.assets;
create policy assets_read on public.assets for select to authenticated using(created_by=auth.uid() or public.is_admin() or (status='validée' and exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.brand_id=assets.brand_id)));
drop policy if exists assets_insert_self on public.assets;
create policy assets_insert_self on public.assets for insert to authenticated with check(created_by=auth.uid() and status='en_attente');
drop policy if exists assets_admin_manage on public.assets;
create policy assets_admin_manage on public.assets for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists videos_read on public.videos;
create policy videos_read on public.videos for select to authenticated using(user_id=auth.uid() or public.is_admin() or (status='review' and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='valideur' and p.is_active and p.brand_id=videos.brand_id and p.department=videos.department)));
drop policy if exists videos_insert_self on public.videos;
create policy videos_insert_self on public.videos for insert to authenticated with check(user_id=auth.uid() and status='draft');
drop policy if exists videos_admin_manage on public.videos;
create policy videos_admin_manage on public.videos for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists versions_read on public.video_versions;
create policy versions_read on public.video_versions for select to authenticated using(exists(select 1 from public.videos v where v.id=video_id and (v.user_id=auth.uid() or public.is_admin() or (v.status='review' and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='valideur' and p.is_active and p.brand_id=v.brand_id and p.department=v.department)))));
drop policy if exists versions_admin_manage on public.video_versions;
create policy versions_admin_manage on public.video_versions for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists validations_read on public.validations;
create policy validations_read on public.validations for select to authenticated using(public.is_admin() or submitted_by=auth.uid() or (status='pending' and exists(select 1 from public.profiles p join public.videos v on v.id=validations.video_id where p.id=auth.uid() and p.role='valideur' and p.is_active and p.brand_id=v.brand_id and p.department=v.department)));
drop policy if exists validations_admin_manage on public.validations;
create policy validations_admin_manage on public.validations for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists validations_validator_review on public.validations;
create policy validations_validator_review on public.validations for update to authenticated using(status='pending' and exists(select 1 from public.profiles p join public.videos v on v.id=validations.video_id where p.id=auth.uid() and p.role='valideur' and p.is_active and p.brand_id=v.brand_id and p.department=v.department)) with check(reviewed_by=auth.uid() and status in ('approved','rejected') and reviewed_at is not null);
create or replace function public.guard_validation_update() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.video_id is distinct from old.video_id or new.version_id is distinct from old.version_id
    or new.submitted_by is distinct from old.submitted_by or new.created_at is distinct from old.created_at then
    raise exception using errcode='42501', message='Champs de validation non modifiables';
  end if;
  if old.status <> 'pending' or new.status not in ('approved','rejected')
    or (current_setting('request.jwt.claim.role', true) <> 'service_role' and new.reviewed_by <> auth.uid())
    or new.reviewed_at is null then
    raise exception using errcode='42501', message='Transition de validation non autorisée';
  end if;
  if new.status='rejected' and length(trim(coalesce(new.reason,'')))=0 then
    raise exception using errcode='22023', message='Un motif est obligatoire pour refuser une vidéo';
  end if;
  return new;
end $$;
drop trigger if exists guard_validation_update_trigger on public.validations;
create trigger guard_validation_update_trigger before update on public.validations for each row execute function public.guard_validation_update();
drop policy if exists ledger_admin_read on public.usage_ledger;
create policy ledger_admin_read on public.usage_ledger for select to authenticated using(public.is_admin());
drop policy if exists comparisons_admin_all on public.comparisons;
create policy comparisons_admin_all on public.comparisons for all to authenticated using(public.is_admin()) with check(public.is_admin());

-- Expose model choices without revealing provider unit costs to collaborators or validators.
create or replace view public.model_catalog with (security_invoker=true) as
  select id,name,tier,adapter_family,mode,allowed_durations,allowed_formats,is_active,is_default from public.ai_models;
revoke all on public.ai_models from anon,authenticated;
grant select on public.ai_models to authenticated;
grant select on public.model_catalog to authenticated;

-- Storage objects are private. Uploads go into a first-level folder named with auth.uid().
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
  ('assets','assets',false,26214400,array['image/jpeg','image/png','image/webp']::text[]),
  ('videos','videos',false,104857600,array['video/mp4']::text[]),
  ('audio','audio',false,26214400,array['audio/mpeg','audio/wav','audio/mp4']::text[]),
  ('brand','brand',false,26214400,array['image/jpeg','image/png','image/webp']::text[])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists rimco_storage_read on storage.objects;
create policy rimco_storage_read on storage.objects for select to authenticated using(
  public.is_admin() or
  (bucket_id='brand' and (storage.foldername(name))[1]=auth.uid()::text) or
  (bucket_id='brand' and exists(select 1 from public.assets a join public.profiles p on p.id=auth.uid() and p.brand_id=a.brand_id and p.is_active where a.path=name and a.kind='logo' and a.status='validée')) or
  (bucket_id in ('assets','audio') and (storage.foldername(name))[1]=auth.uid()::text) or
  (bucket_id='assets' and exists(select 1 from public.assets a where a.path=name and a.status='validée')) or
  (bucket_id='audio' and exists(select 1 from public.assets a where a.path=name and a.kind='audio' and a.status='validée')) or
  (bucket_id='videos' and exists(select 1 from public.videos v join public.video_versions vv on vv.video_id=v.id where v.user_id=auth.uid() and v.status='approved' and vv.final_path=name)) or
  (bucket_id='videos' and exists(select 1 from public.profiles p join public.videos v on v.brand_id=p.brand_id and v.department=p.department and v.status='review' join public.video_versions vv on vv.video_id=v.id where p.id=auth.uid() and p.role='valideur' and p.is_active and vv.final_path=name))
);

-- Collaborator workflow extensions (idempotent).
alter table public.videos drop constraint if exists videos_status_check;
alter table public.videos add constraint videos_status_check check (status in ('draft','generating','ready','review','approved','rejected','failed','cancelled'));
alter table public.video_versions drop constraint if exists video_versions_status_check;
alter table public.video_versions add constraint video_versions_status_check check (status in ('queued','generating','postprocessing','ready','failed','cancelled'));
alter table public.assets add column if not exists title text;
alter table public.assets add column if not exists category text;
alter table public.assets drop constraint if exists assets_kind_check;
alter table public.assets add constraint assets_kind_check check (kind in ('vehicle','logo','audio','place','decor','wardrobe','badge'));
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  version_id uuid references public.video_versions(id) on delete cascade, type text not null check (type in ('ready','failed','cancelled','validation')),
  message text not null, read_at timestamptz, created_at timestamptz not null default now()
);
alter table public.notifications enable row level security;
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated using (user_id=auth.uid());
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
create index if not exists notifications_user_created_idx on public.notifications(user_id,created_at desc);
drop policy if exists rimco_storage_upload on storage.objects;
create policy rimco_storage_upload on storage.objects for insert to authenticated with check(bucket_id in ('assets','audio','brand') and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists rimco_storage_update on storage.objects;
create policy rimco_storage_update on storage.objects for update to authenticated using(bucket_id in ('assets','audio','brand') and (storage.foldername(name))[1]=auth.uid()::text) with check(bucket_id in ('assets','audio','brand') and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists rimco_storage_delete on storage.objects;
create policy rimco_storage_delete on storage.objects for delete to authenticated using(public.is_admin() or (bucket_id in ('assets','audio','brand') and (storage.foldername(name))[1]=auth.uid()::text));
-- Validators preview the composed file once it is ready for review.
drop policy if exists rimco_storage_read on storage.objects;
create policy rimco_storage_read on storage.objects for select to authenticated using(
  public.is_admin() or
  (bucket_id='brand' and (storage.foldername(name))[1]=auth.uid()::text) or
  (bucket_id='brand' and exists(select 1 from public.assets a join public.profiles p on p.id=auth.uid() and p.brand_id=a.brand_id and p.is_active where a.path=name and a.kind='logo' and a.status='validée')) or
  (bucket_id in ('assets','audio') and (storage.foldername(name))[1]=auth.uid()::text) or
  (bucket_id='assets' and exists(select 1 from public.assets a where a.path=name and a.status='validée')) or
  (bucket_id='audio' and exists(select 1 from public.assets a where a.path=name and a.kind='audio' and a.status='validée')) or
  (bucket_id='videos' and exists(select 1 from public.videos v join public.video_versions vv on vv.video_id=v.id where v.user_id=auth.uid() and v.status='approved' and vv.final_path=name)) or
  (bucket_id='videos' and exists(select 1 from public.profiles p join public.videos v on v.brand_id=p.brand_id and v.department=p.department and v.status='review' join public.video_versions vv on vv.video_id=v.id where p.id=auth.uid() and p.role='valideur' and p.is_active and vv.final_path=name))
);
-- Reserve the maximum configured token cost before each fal LLM request.
create or replace function public.reserve_llm_budget(
  p_user_id uuid, p_version_id uuid, p_max_cost_usd numeric,
  p_usd_to_eur numeric, p_eur_to_fcfa numeric, p_cap_eur numeric, p_department text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare entry_id uuid; estimated_eur numeric;
begin
  if p_max_cost_usd is null or p_max_cost_usd <= 0 or p_usd_to_eur is null or p_usd_to_eur <= 0
    or p_eur_to_fcfa is null or p_eur_to_fcfa <= 0 or p_cap_eur is null or p_cap_eur < 0 then
    raise exception using errcode='22023', message='Paramètres de réservation LLM invalides';
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_user_id and p.is_active)
    or not exists(select 1 from public.video_versions vv join public.videos v on v.id=vv.video_id where vv.id=p_version_id and v.user_id=p_user_id) then
    raise exception using errcode='22023', message='Réservation LLM impossible pour cette version';
  end if;
  estimated_eur := p_max_cost_usd * p_usd_to_eur;
  perform pg_advisory_xact_lock(hashtext('rimco_budget_cap_eur'));
  if coalesce((select sum(l.cost_eur) from public.usage_ledger l where l.status in ('reserved','charged')),0) + estimated_eur > p_cap_eur then
    raise exception using errcode='P0001', message='Plafond de coût réel dépassé';
  end if;
  insert into public.usage_ledger(version_id,user_id,department,ai_model_id,kind,seconds,cost_usd,cost_eur,cost_real_fcfa,applied_fcfa_per_second,price_fcfa,status)
  values(p_version_id,p_user_id,coalesce(p_department,''),null,'generation',1,p_max_cost_usd,estimated_eur,estimated_eur*p_eur_to_fcfa,0,0,'reserved') returning id into entry_id;
  return entry_id;
end $$;
revoke all on function public.reserve_llm_budget(uuid,uuid,numeric,numeric,numeric,numeric,text) from public, anon, authenticated;
grant execute on function public.reserve_llm_budget(uuid,uuid,numeric,numeric,numeric,numeric,text) to service_role;
-- Refresh the catalog from verified provider schemas; unsupported models stay inactive.
update public.ai_models set is_active=false, is_default=false where fal_endpoint_id='TODO(verify-fal)';

update public.ai_models set allowed_durations='{6}', allowed_formats='{16:9,9:16}', is_active=true, is_default=true
where fal_endpoint_id='fal-ai/veo3.1/fast/image-to-video';

update public.ai_models set price_usd_per_second=0, allowed_durations='{}', allowed_formats='{}', is_active=false, is_default=false
where fal_endpoint_id='fal-ai/minimax/hailuo-2.3/pro/image-to-video';

insert into public.ai_models(name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default)
values ('Wan 3.0','standard','alibaba/wan-3.0/image-to-video','wan','image_to_video',0.10,'{5}','{16:9,9:16,1:1}',true,false)
on conflict(name) do update set tier=excluded.tier,fal_endpoint_id=excluded.fal_endpoint_id,
  adapter_family=excluded.adapter_family,mode=excluded.mode,price_usd_per_second=excluded.price_usd_per_second,
  allowed_durations=excluded.allowed_durations,allowed_formats=excluded.allowed_formats,
  is_active=excluded.is_active,is_default=excluded.is_default;
alter table public.videos drop constraint if exists videos_status_check;
alter table public.videos add constraint videos_status_check check (status in ('draft','generating','ready','review','approved','rejected','failed','cancelled'));

drop policy if exists rimco_storage_read on storage.objects;
create policy rimco_storage_read on storage.objects for select to authenticated using(
  public.is_admin() or
  (bucket_id='brand' and (storage.foldername(name))[1]=auth.uid()::text) or
  (bucket_id='brand' and exists(select 1 from public.assets a join public.profiles p on p.id=auth.uid() and p.brand_id=a.brand_id and p.is_active where a.path=name and a.kind='logo' and a.status='validée')) or
  (bucket_id in ('assets','audio') and (storage.foldername(name))[1]=auth.uid()::text) or
  (bucket_id='assets' and exists(select 1 from public.assets a where a.path=name and a.status='validée')) or
  (bucket_id='audio' and exists(select 1 from public.assets a where a.path=name and a.kind='audio' and a.status='validée')) or
  (bucket_id='videos' and exists(select 1 from public.videos v join public.video_versions vv on vv.video_id=v.id where v.user_id=auth.uid() and v.status in ('approved','review') and vv.final_path=name)) or
  (bucket_id='videos' and exists(select 1 from public.profiles p join public.videos v on v.brand_id=p.brand_id and v.department=p.department and v.status='review' join public.video_versions vv on vv.video_id=v.id where p.id=auth.uid() and p.role='valideur' and p.is_active and vv.final_path=name))
);
-- Seed de démonstration idempotent. Endpoints et tarifs contrôlés dans la documentation fal.ai.
insert into public.brands(name,primary_color,secondary_color)
values ('RIMCO Motors','#c51e1c','#831810')
on conflict(name) do update set primary_color=excluded.primary_color,secondary_color=excluded.secondary_color;

insert into public.pricing_settings(brand_id,grid_fcfa_per_second_standard,grid_fcfa_per_second_premium)
select id,460,700 from public.brands where name='RIMCO Motors'
on conflict(brand_id) do update set grid_fcfa_per_second_standard=excluded.grid_fcfa_per_second_standard,
  grid_fcfa_per_second_premium=excluded.grid_fcfa_per_second_premium;

-- Les tarifs fal sont des estimations de coût unitaire; revalider avant activation commerciale.
update public.ai_models set is_active=false,is_default=false where fal_endpoint_id='fal-ai/kling-video/v2.6/pro/image-to-video';
update public.ai_models set is_default=false where tier='standard';
insert into public.ai_models(name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default)
values
  ('Kling O3 Pro','standard','fal-ai/kling-video/o3/pro/image-to-video','kling','image_to_video',0.112,'{5,10,15}','{16:9,9:16,1:1}',true,true),
  ('Seedance 2.5','premium','bytedance/seedance-2.5/image-to-video','seedance','image_to_video',0.473,'{5,10,15,20,30}','{16:9,9:16,1:1}',true,false),
  ('Veo 3.1 Fast','premium','fal-ai/veo3.1/fast/image-to-video','veo','image_to_video',0.10,'{6}','{16:9,9:16}',true,true),
  ('Hailuo 2.3 Pro','test','fal-ai/minimax/hailuo-2.3/pro/image-to-video','minimax','image_to_video',0,'{}','{}',false,false),
  ('Wan 3.0','standard','alibaba/wan-3.0/image-to-video','wan','image_to_video',0.10,'{5}','{16:9,9:16,1:1}',true,false)
on conflict(name) do update set tier=excluded.tier,fal_endpoint_id=excluded.fal_endpoint_id,
  adapter_family=excluded.adapter_family,mode=excluded.mode,price_usd_per_second=excluded.price_usd_per_second,
  allowed_durations=excluded.allowed_durations,allowed_formats=excluded.allowed_formats,
  is_active=excluded.is_active,is_default=excluded.is_default;

-- Migration 0006: nouveaux modèles vidéo et remplacement de Kling 2.6 Pro.
update public.ai_models set is_active=false,is_default=false
where fal_endpoint_id='fal-ai/kling-video/v2.6/pro/image-to-video';
insert into public.ai_models(name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default)
values
  ('Kling O3 Pro','standard','fal-ai/kling-video/o3/pro/image-to-video','kling','image_to_video',0.112,'{5}','{16:9,9:16,1:1}',true,true),
  ('Seedance 2.5','premium','bytedance/seedance-2.5/image-to-video','seedance','image_to_video',0.473,'{5}','{16:9,9:16,1:1}',true,false)
on conflict(name) do update set tier=excluded.tier,fal_endpoint_id=excluded.fal_endpoint_id,
  adapter_family=excluded.adapter_family,mode=excluded.mode,price_usd_per_second=excluded.price_usd_per_second,
  allowed_durations=excluded.allowed_durations,allowed_formats=excluded.allowed_formats,
  is_active=excluded.is_active,is_default=excluded.is_default;
update public.ai_models set is_default=false
where tier='premium' and fal_endpoint_id='bytedance/seedance-2.5/image-to-video';
-- Apply a 30% markup to the combined provider charge when a generation reservation is settled.
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
-- Enable requested output durations on the verified image-to-video endpoints.
-- Veo keeps a 5s final output (6s source); Kling supports up to 15s; Seedance up to 30s.
alter table public.video_versions drop constraint if exists video_versions_generation_seconds_check;
alter table public.video_versions add constraint video_versions_generation_seconds_check check (generation_seconds in (5,10,15,20,30));

update public.ai_models
set allowed_durations='{5,10,15}'
where fal_endpoint_id='fal-ai/kling-video/o3/pro/image-to-video';

update public.ai_models
set allowed_durations='{5,10,15,20,30}'
where fal_endpoint_id='bytedance/seedance-2.5/image-to-video';

-- The application stores final output duration. Veo's six-second source remains adapter-owned.
update public.ai_models
set allowed_durations='{5}'
where fal_endpoint_id='fal-ai/veo3.1/fast/image-to-video';

-- 0009_generation_model_routing.sql: fixed model by level and output duration.
update public.ai_models set is_default=false where is_default;
update public.ai_models
set tier='standard', allowed_durations='{5}', is_default=false
where fal_endpoint_id='alibaba/wan-3.0/image-to-video';
update public.ai_models
set tier='standard', allowed_durations='{10,15}', is_default=true
where fal_endpoint_id='fal-ai/kling-video/o3/pro/image-to-video';
update public.ai_models
set tier='premium', allowed_durations='{5}', is_default=true
where fal_endpoint_id='fal-ai/veo3.1/fast/image-to-video';
update public.ai_models
set tier='premium', allowed_durations='{10,15,20,30}', is_default=false
where fal_endpoint_id='bytedance/seedance-2.5/image-to-video';

-- 0010_video_shots.sql: two independently generated 3-second shots per montage.
create table if not exists public.video_shots (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.video_versions(id) on delete cascade,
  shot_number integer not null check (shot_number between 1 and 2),
  duration_seconds integer not null check (duration_seconds = 3),
  title text not null,
  generated_prompt text not null,
  provider_request_id text,
  usage_ledger_id uuid references public.usage_ledger(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','generating','postprocessing','ready','failed')),
  raw_path text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(version_id, shot_number)
);
alter table public.video_versions drop constraint if exists video_versions_generation_seconds_check;
alter table public.video_versions add constraint video_versions_generation_seconds_check check (generation_seconds in (5,6,10,15,20,30));
alter table public.video_shots enable row level security;
drop policy if exists video_shots_admin_read on public.video_shots;
create policy video_shots_admin_read on public.video_shots for select to authenticated using (public.is_admin());
create index if not exists video_shots_version_status_idx on public.video_shots(version_id, shot_number, status);

-- 0011_remove_app_budget_cap.sql: provider spending cap lives in fal.ai; app keeps cost accounting.
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

-- 0012_generation_model_routing.sql: keep the live catalog aligned with the Studio.
update public.ai_models
set is_active=false, is_default=false
where fal_endpoint_id='fal-ai/kling-video/v2.6/pro/image-to-video';
update public.ai_models set is_default=false where tier in ('standard','premium');
update public.ai_models
set tier='standard', allowed_durations='{5}', is_active=true, is_default=false
where fal_endpoint_id='alibaba/wan-3.0/image-to-video';
update public.ai_models
set tier='standard', allowed_durations='{10,15}', is_active=true, is_default=true
where fal_endpoint_id='fal-ai/kling-video/o3/pro/image-to-video';
update public.ai_models
set tier='premium', allowed_durations='{5}', is_active=true, is_default=true
where fal_endpoint_id='fal-ai/veo3.1/fast/image-to-video';
update public.ai_models
set tier='premium', allowed_durations='{10,15,20,30}', is_active=true, is_default=false
where fal_endpoint_id='bytedance/seedance-2.5/image-to-video';

-- Canonical final state. This block intentionally runs last so the one-shot setup
-- remains idempotent even when it is applied over an older beta schema.
alter table public.videos drop constraint if exists videos_status_check;
alter table public.videos add constraint videos_status_check check (status in ('draft','generating','ready','review','approved','rejected','failed','cancelled'));
alter table public.video_versions drop constraint if exists video_versions_status_check;
alter table public.video_versions add constraint video_versions_status_check check (status in ('queued','generating','postprocessing','ready','failed','cancelled'));
alter table public.assets drop constraint if exists assets_kind_check;
alter table public.assets add constraint assets_kind_check check (kind in ('vehicle','logo','audio','place','decor','wardrobe','badge'));
create unique index if not exists notifications_user_version_type_idx
  on public.notifications(user_id, version_id, type)
  where version_id is not null;

notify pgrst, 'reload schema';

-- Migration 0017 : matrice vidéo verrouillée (idempotent).
update public.ai_models set is_active = false, is_default = false
where fal_endpoint_id not in ('alibaba/wan-3.0/image-to-video','fal-ai/kling-video/o3/pro/image-to-video','fal-ai/veo3.1/fast/image-to-video','bytedance/seedance-2.5/image-to-video');
update public.ai_models set is_active=true,is_default=false,tier='standard',allowed_durations='{5}',allowed_formats='{16:9,9:16,1:1}' where fal_endpoint_id='alibaba/wan-3.0/image-to-video';
update public.ai_models set is_active=true,is_default=true,tier='standard',allowed_durations='{10,15}',allowed_formats='{16:9,9:16,1:1}' where fal_endpoint_id='fal-ai/kling-video/o3/pro/image-to-video';
update public.ai_models set is_active=true,is_default=true,tier='premium',allowed_durations='{6}',allowed_formats='{16:9,9:16}' where fal_endpoint_id='fal-ai/veo3.1/fast/image-to-video';
update public.ai_models set is_active=true,is_default=false,tier='premium',allowed_durations='{10,15,20,30}',allowed_formats='{16:9,9:16,1:1}' where fal_endpoint_id='bytedance/seedance-2.5/image-to-video';

-- 0018_vehicle_dossiers_places_admin.sql: explicit vehicle folders and photo roles.
create table if not exists public.vehicle_dossiers (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  make text not null check (length(trim(make)) between 1 and 100),
  model text not null check (length(trim(model)) between 1 and 100),
  color text,
  variant text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.assets add column if not exists vehicle_dossier_id uuid references public.vehicle_dossiers(id) on delete set null;
alter table public.assets add column if not exists photo_role text;
alter table public.assets drop constraint if exists assets_photo_role_check;
alter table public.assets add constraint assets_photo_role_check check (photo_role is null or photo_role in ('exterior','interior','detail'));
create index if not exists vehicle_dossiers_brand_created_idx on public.vehicle_dossiers(brand_id, created_at desc);
create index if not exists assets_vehicle_dossier_idx on public.assets(vehicle_dossier_id) where vehicle_dossier_id is not null;
alter table public.vehicle_dossiers enable row level security;
drop policy if exists vehicle_dossiers_read_brand on public.vehicle_dossiers;
create policy vehicle_dossiers_read_brand on public.vehicle_dossiers for select to authenticated
  using (public.is_admin() or exists (select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.brand_id=vehicle_dossiers.brand_id));
drop policy if exists vehicle_dossiers_admin_manage on public.vehicle_dossiers;
create policy vehicle_dossiers_admin_manage on public.vehicle_dossiers for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists assets_insert_self on public.assets;
create policy assets_insert_self on public.assets for insert to authenticated
  with check (created_by=auth.uid() and status='en_attente' and kind <> 'place');
notify pgrst, 'reload schema';

-- Migration 0019 : storyboard et montage multi-clips (idempotent).
alter table public.video_shots drop constraint if exists video_shots_shot_number_check;
alter table public.video_shots add constraint video_shots_shot_number_check check (shot_number between 1 and 6);
alter table public.video_shots drop constraint if exists video_shots_duration_seconds_check;
alter table public.video_shots add constraint video_shots_duration_seconds_check check (duration_seconds between 2 and 30);
insert into public.ai_models(name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default)
values
  ('Wan 2.7 Reference to Video','standard','fal-ai/wan/v2.7/reference-to-video','wan','image_to_video',0.10,'{2,3,4,5,6,7,8,9,10}','{16:9,9:16,1:1,4:3,3:4}',true,false),
  ('Kling O3 Pro Reference to Video','standard','fal-ai/kling-video/o3/pro/reference-to-video','kling','image_to_video',0.112,'{3,4,5,6,7,8,9,10,11,12,13,14,15}','{16:9,9:16,1:1}',true,false),
  ('Seedance 2.5 Reference to Video','premium','bytedance/seedance-2.5/reference-to-video','seedance','image_to_video',0.473,'{4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30}','{16:9,9:16,1:1,4:3,3:4,21:9}',true,false)
on conflict(name) do update set tier=excluded.tier,fal_endpoint_id=excluded.fal_endpoint_id,
  adapter_family=excluded.adapter_family,mode=excluded.mode,price_usd_per_second=excluded.price_usd_per_second,
  allowed_durations=excluded.allowed_durations,allowed_formats=excluded.allowed_formats,is_active=excluded.is_active,is_default=false;
notify pgrst, 'reload schema';

-- 0020_storyboard_cost_guardrails.sql
alter table public.ai_models add column if not exists pricing_verified_at timestamptz;
alter table public.video_shots add column if not exists price_usd_per_second numeric(12,6);
alter table public.video_shots add column if not exists estimated_cost_usd numeric(12,6);
alter table public.video_shots add column if not exists actual_cost_usd numeric(12,6);
create or replace function public.reserve_storyboard_comparison_budget(p_campaign_id uuid,p_amount_usd numeric,p_max_usd numeric)
returns numeric language plpgsql security definer set search_path=public as $$
declare current_brief jsonb; current_reserved numeric; next_reserved numeric; old_durations jsonb;
begin
  if p_amount_usd<=0 or p_max_usd<=0 then raise exception 'Invalid storyboard budget amount'; end if;
  select brief_json into current_brief from public.comparisons where id=p_campaign_id for update;
  if current_brief is null or current_brief->>'kind'<>'storyboard_multiclip_comparison' then raise exception 'Storyboard comparison campaign not found'; end if;
  current_reserved:=coalesce((current_brief->>'reservedUsd')::numeric,0); next_reserved:=current_reserved+p_amount_usd;
  if next_reserved>p_max_usd then return null; end if;
  old_durations:=coalesce(current_brief->'durations','[]'::jsonb);
  update public.comparisons set brief_json=current_brief||jsonb_build_object('reservedUsd',next_reserved,'durations',old_durations,'budgetUpdatedAt',now()) where id=p_campaign_id;
  return next_reserved;
end; $$;
revoke all on function public.reserve_storyboard_comparison_budget(uuid,numeric,numeric) from public,anon,authenticated;
grant execute on function public.reserve_storyboard_comparison_budget(uuid,numeric,numeric) to service_role;

-- 0021_generation_pro_tier.sql
alter table public.ai_models drop constraint if exists ai_models_tier_check;
alter table public.ai_models add constraint ai_models_tier_check check (tier in ('standard','pro','premium','test'));
update public.ai_models set is_default=false where tier in ('standard','pro','premium');
update public.ai_models set tier='standard',allowed_durations='{5}',is_default=true where fal_endpoint_id='alibaba/wan-3.0/image-to-video';
update public.ai_models set tier='pro',allowed_durations='{5,10,15}',is_default=true where fal_endpoint_id='fal-ai/kling-video/o3/pro/image-to-video';
update public.ai_models set tier='pro',is_default=false where fal_endpoint_id='fal-ai/kling-video/o3/pro/reference-to-video';
update public.ai_models set tier='premium',is_default=true where fal_endpoint_id='fal-ai/veo3.1/fast/image-to-video';
update public.ai_models set tier='premium',is_default=false where fal_endpoint_id in ('bytedance/seedance-2.5/image-to-video','bytedance/seedance-2.5/reference-to-video');
notify pgrst, 'reload schema';

-- 0022_seedance_premium_and_logo_duration.sql
-- Selected durations represent generated footage; post-production adds the 2s logo card.
update public.ai_models set is_active=false,is_default=false where fal_endpoint_id='fal-ai/veo3.1/fast/image-to-video';
update public.ai_models set is_active=true,is_default=true,tier='premium',allowed_durations='{5,10,15,20,30}' where fal_endpoint_id='bytedance/seedance-2.5/image-to-video';
update public.ai_models set is_active=true,is_default=false,tier='premium' where fal_endpoint_id='bytedance/seedance-2.5/reference-to-video';
alter table public.video_versions drop constraint if exists video_versions_generation_seconds_check;
alter table public.video_versions add constraint video_versions_generation_seconds_check check (generation_seconds in (5,6,7,10,12,15,17,20,22,30,32));
notify pgrst, 'reload schema';
-- Store replaceable Fal API keys encrypted by the application server.
create table if not exists public.fal_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  is_active boolean not null default false
);

create unique index if not exists fal_provider_credentials_one_active_idx
  on public.fal_provider_credentials(is_active) where is_active;

alter table public.video_versions
  add column if not exists fal_credential_id uuid references public.fal_provider_credentials(id) on delete set null;

create index if not exists video_versions_fal_credential_idx
  on public.video_versions(fal_credential_id) where fal_credential_id is not null;

alter table public.fal_provider_credentials enable row level security;
revoke all on public.fal_provider_credentials from anon, authenticated;
grant select, insert, update, delete on public.fal_provider_credentials to service_role;

create or replace function public.activate_fal_provider_credential(p_credential_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.fal_provider_credentials set is_active=false where is_active;
  update public.fal_provider_credentials set is_active=true where id=p_credential_id;
  if not found then
    raise exception using errcode='P0002', message='Fal credential not found';
  end if;
end $$;
revoke all on function public.activate_fal_provider_credential(uuid) from public, anon, authenticated;
grant execute on function public.activate_fal_provider_credential(uuid) to service_role;

notify pgrst, 'reload schema';
