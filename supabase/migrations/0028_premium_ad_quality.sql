-- Track actual generation cost separately from the requested runtime that the user pays for.
alter table public.usage_ledger add column if not exists billable_seconds numeric(10,3)
  check (billable_seconds is null or billable_seconds >= 0);
alter table public.usage_ledger add column if not exists billable_cost_usd numeric(10,6)
  check (billable_cost_usd is null or billable_cost_usd >= 0);

-- Persist the final-video quality gate and its single automatic retry per clip.
alter table public.video_shots add column if not exists video_quality_status text not null default 'skipped'
  check (video_quality_status in ('skipped','queued','checking','passed','retrying','failed'));
alter table public.video_shots add column if not exists video_quality_request_id text;
alter table public.video_shots add column if not exists video_quality_endpoint text;
alter table public.video_shots add column if not exists video_quality_retry_count integer not null default 0
  check (video_quality_retry_count between 0 and 1);
alter table public.video_shots add column if not exists video_quality jsonb;
alter table public.video_shots add column if not exists video_quality_previous_path text;
alter table public.video_shots add column if not exists video_quality_ledger_ids uuid[] not null default '{}';

create index if not exists video_shots_video_quality_status_idx
  on public.video_shots(version_id, video_quality_status)
  where video_quality_status in ('queued','checking','retrying');

notify pgrst, 'reload schema';
