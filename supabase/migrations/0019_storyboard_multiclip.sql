-- Variable multi-shot storyboards; every final video reserves two seconds for the brand card.
alter table public.video_shots drop constraint if exists video_shots_shot_number_check;
alter table public.video_shots add constraint video_shots_shot_number_check check (shot_number between 1 and 6);
alter table public.video_shots drop constraint if exists video_shots_duration_seconds_check;
alter table public.video_shots add constraint video_shots_duration_seconds_check check (duration_seconds between 2 and 30);

-- Dedicated reference-to-video routes coexist with the historical single-image endpoints.
insert into public.ai_models(name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default)
values
  ('Wan 2.7 Reference to Video','standard','fal-ai/wan/v2.7/reference-to-video','wan','image_to_video',0.10,'{2,3,4,5,6,7,8,9,10}','{16:9,9:16,1:1,4:3,3:4}',true,false),
  ('Kling O3 Pro Reference to Video','standard','fal-ai/kling-video/o3/pro/reference-to-video','kling','image_to_video',0.112,'{3,4,5,6,7,8,9,10,11,12,13,14,15}','{16:9,9:16,1:1}',true,false),
  ('Seedance 2.5 Reference to Video','premium','bytedance/seedance-2.5/reference-to-video','seedance','image_to_video',0.473,'{4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30}','{16:9,9:16,1:1,4:3,3:4,21:9}',true,false)
on conflict(name) do update set tier=excluded.tier,fal_endpoint_id=excluded.fal_endpoint_id,
  adapter_family=excluded.adapter_family,mode=excluded.mode,price_usd_per_second=excluded.price_usd_per_second,
  allowed_durations=excluded.allowed_durations,allowed_formats=excluded.allowed_formats,is_active=excluded.is_active,is_default=false;

notify pgrst, 'reload schema';
