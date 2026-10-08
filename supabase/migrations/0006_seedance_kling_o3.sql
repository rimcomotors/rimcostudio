-- Remplace Kling 2.6 Pro et active les endpoints image-to-video vérifiés de Kling O3 Pro et Seedance 2.5.
update public.ai_models
set is_active=false, is_default=false
where fal_endpoint_id='fal-ai/kling-video/v2.6/pro/image-to-video';
update public.ai_models set is_default=false where tier='standard';

insert into public.ai_models(name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default)
values
  ('Kling O3 Pro','standard','fal-ai/kling-video/o3/pro/image-to-video','kling','image_to_video',0.112,'{5}','{16:9,9:16,1:1}',true,true),
  ('Seedance 2.5','premium','bytedance/seedance-2.5/image-to-video','seedance','image_to_video',0.473,'{5}','{16:9,9:16,1:1}',true,false)
on conflict(name) do update set tier=excluded.tier,fal_endpoint_id=excluded.fal_endpoint_id,
  adapter_family=excluded.adapter_family,mode=excluded.mode,price_usd_per_second=excluded.price_usd_per_second,
  allowed_durations=excluded.allowed_durations,allowed_formats=excluded.allowed_formats,
  is_active=excluded.is_active,is_default=excluded.is_default;

-- La génération Premium par défaut reste Veo 3.1 Fast; Seedance est sélectionnable dans le studio.
update public.ai_models set is_default=false
where tier='premium' and fal_endpoint_id='bytedance/seedance-2.5/image-to-video';
