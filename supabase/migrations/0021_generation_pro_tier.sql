-- Add Pro as a first-class classic generation tier. Storyboard modes remain separately governed.
alter table public.ai_models drop constraint if exists ai_models_tier_check;
alter table public.ai_models add constraint ai_models_tier_check check (tier in ('standard','pro','premium','test'));

-- Wan is the 5-second Standard route; Kling O3 is Pro at 5/10/15 seconds.
update public.ai_models set is_default = false where tier in ('standard','pro','premium');
update public.ai_models
set tier = 'standard', allowed_durations = '{5}', is_default = true
where fal_endpoint_id = 'alibaba/wan-3.0/image-to-video';
update public.ai_models
set tier = 'pro', allowed_durations = '{5,10,15}', is_default = true
where fal_endpoint_id = 'fal-ai/kling-video/o3/pro/image-to-video';
update public.ai_models
set tier = 'pro', is_default = false
where fal_endpoint_id = 'fal-ai/kling-video/o3/pro/reference-to-video';
update public.ai_models
set tier = 'premium', is_default = true
where fal_endpoint_id = 'fal-ai/veo3.1/fast/image-to-video';
update public.ai_models
set tier = 'premium', is_default = false
where fal_endpoint_id in ('bytedance/seedance-2.5/image-to-video','bytedance/seedance-2.5/reference-to-video');

notify pgrst, 'reload schema';
