-- Persist a compare-and-set guard around paid animation submissions.
alter table public.video_shots add column if not exists animation_submit_state text not null default 'queued'
  check (animation_submit_state in ('queued','submitting','submitted','failed','reconciliation'));
alter table public.video_shots add column if not exists animation_submit_started_at timestamptz;

-- Existing provider requests must never be submitted again after this migration.
update public.video_shots
set animation_submit_state = case
  when provider_request_id is not null then 'submitted'
  when provider_reconciliation_required then 'reconciliation'
  when status = 'failed' then 'failed'
  else 'queued'
end
where animation_submit_state = 'queued';

create index if not exists video_shots_animation_submit_state_idx
  on public.video_shots(version_id, animation_submit_state, shot_number);

notify pgrst, 'reload schema';
