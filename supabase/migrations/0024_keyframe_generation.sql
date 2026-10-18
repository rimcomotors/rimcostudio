-- Persist image generation and quality-gate state before any video clip is submitted.
alter table public.video_shots add column if not exists keyframe_status text not null default 'skipped'
  check (keyframe_status in ('skipped','queued','generating','checking','ready','failed'));
alter table public.video_shots add column if not exists keyframe_request_id text;
alter table public.video_shots add column if not exists keyframe_quality_request_id text;
alter table public.video_shots add column if not exists keyframe_path text;
alter table public.video_shots add column if not exists keyframe_retry_count integer not null default 0 check (keyframe_retry_count between 0 and 1);
alter table public.video_shots add column if not exists keyframe_quality jsonb;
alter table public.video_shots add column if not exists keyframe_image_ledger_ids uuid[] not null default '{}';
alter table public.video_shots add column if not exists keyframe_quality_ledger_ids uuid[] not null default '{}';

alter table public.usage_ledger drop constraint if exists usage_ledger_kind_check;
alter table public.usage_ledger add constraint usage_ledger_kind_check check (kind in ('generation','postprod','keyframe'));
create index if not exists video_shots_keyframe_status_idx on public.video_shots(version_id, keyframe_status);

-- These image-to-video models animate the accepted keyframe as the actual start frame.
-- fal schemas and rates were rechecked on 2026-10-18.
update public.ai_models set tier='pro',adapter_family='kling',mode='image_to_video',is_active=true,
  price_usd_per_second=0.112,allowed_durations='{3,4,5,6,7,8,9,10,11,12,13,14,15}',
  allowed_formats='{16:9,9:16,1:1}',pricing_verified_at=now()
where fal_endpoint_id='fal-ai/kling-video/o3/pro/image-to-video';
update public.ai_models set tier='premium',adapter_family='seedance',mode='image_to_video',is_active=true,
  price_usd_per_second=0.473,allowed_durations='{4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30}',
  allowed_formats='{16:9,9:16,1:1}',pricing_verified_at=now()
where fal_endpoint_id='bytedance/seedance-2.5/image-to-video';
notify pgrst, 'reload schema';
