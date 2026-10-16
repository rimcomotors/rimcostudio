-- Premium routes to Seedance while Veo is temporarily unavailable.
-- User-selected durations represent generated footage; post-production adds the 2s logo card.
update public.ai_models
set is_active=false,is_default=false
where fal_endpoint_id='fal-ai/veo3.1/fast/image-to-video';

update public.ai_models
set is_active=true,is_default=true,tier='premium',allowed_durations='{5,10,15,20,30}'
where fal_endpoint_id='bytedance/seedance-2.5/image-to-video';

update public.ai_models
set is_active=true,is_default=false,tier='premium'
where fal_endpoint_id='bytedance/seedance-2.5/reference-to-video';

alter table public.video_versions drop constraint if exists video_versions_generation_seconds_check;
alter table public.video_versions add constraint video_versions_generation_seconds_check
check (generation_seconds in (5,6,7,10,12,15,17,20,22,30,32));

notify pgrst, 'reload schema';
