-- Use the user-facing tier and duration to select the provider deterministically.
update public.ai_models set is_default = false where is_default;

update public.ai_models
set tier = 'standard', allowed_durations = '{5}', is_default = false
where fal_endpoint_id = 'alibaba/wan-3.0/image-to-video';

update public.ai_models
set tier = 'standard', allowed_durations = '{10,15}', is_default = true
where fal_endpoint_id = 'fal-ai/kling-video/o3/pro/image-to-video';

update public.ai_models
set tier = 'premium', allowed_durations = '{5}', is_default = true
where fal_endpoint_id = 'fal-ai/veo3.1/fast/image-to-video';

update public.ai_models
set tier = 'premium', allowed_durations = '{10,15,20,30}', is_default = false
where fal_endpoint_id = 'bytedance/seedance-2.5/image-to-video';
