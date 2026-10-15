-- Explicit vehicle folders keep several validated reference photos attached to one vehicle.
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

-- Place uploads use privileged signed upload URLs, so their issuing API must enforce admin access.
-- RLS also prevents direct client inserts for place metadata; admins retain the manage policy.
drop policy if exists assets_insert_self on public.assets;
create policy assets_insert_self on public.assets for insert to authenticated
  with check (created_by=auth.uid() and status='en_attente' and kind <> 'place');
notify pgrst, 'reload schema';
