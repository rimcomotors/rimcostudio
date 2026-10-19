-- Persist the exact fal endpoint and bounded poll-recovery state for each shot.
alter table public.video_shots add column if not exists provider_endpoint text;
alter table public.video_shots add column if not exists keyframe_endpoint text;
alter table public.video_shots add column if not exists keyframe_quality_endpoint text;
alter table public.video_shots add column if not exists provider_poll_failure_count integer not null default 0;
alter table public.video_shots add column if not exists provider_next_poll_at timestamptz;
alter table public.video_shots add column if not exists provider_last_poll_error text;
alter table public.video_shots add column if not exists provider_reconciliation_required boolean not null default false;

alter table public.video_shots drop constraint if exists video_shots_provider_poll_failure_count_check;
alter table public.video_shots add constraint video_shots_provider_poll_failure_count_check
  check (provider_poll_failure_count between 0 and 4);

create index if not exists video_shots_provider_poll_due_idx
  on public.video_shots(provider_next_poll_at)
  where status = 'generating' or keyframe_status in ('generating','checking');

notify pgrst, 'reload schema';
