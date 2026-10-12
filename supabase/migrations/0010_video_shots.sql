-- Persist independently generated shots belonging to one assembled video version.
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
alter table public.video_versions add constraint video_versions_generation_seconds_check
  check (generation_seconds in (5,6,10,15,20,30));

alter table public.video_shots enable row level security;
drop policy if exists video_shots_admin_read on public.video_shots;
create policy video_shots_admin_read on public.video_shots for select to authenticated using (public.is_admin());

create index if not exists video_shots_version_status_idx on public.video_shots(version_id, shot_number, status);
