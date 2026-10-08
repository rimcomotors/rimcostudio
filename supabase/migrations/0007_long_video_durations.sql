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
