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
