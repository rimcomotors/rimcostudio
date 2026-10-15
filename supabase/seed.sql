-- Seed de démonstration idempotent. Endpoints et tarifs contrôlés dans la documentation fal.ai.
insert into public.brands(name,primary_color,secondary_color)
values ('RIMCO Motors','#c51e1c','#831810')
on conflict(name) do update set primary_color=excluded.primary_color,secondary_color=excluded.secondary_color;

insert into public.pricing_settings(brand_id,grid_fcfa_per_second_standard,grid_fcfa_per_second_premium)
select id,460,700 from public.brands where name='RIMCO Motors'
on conflict(brand_id) do update set grid_fcfa_per_second_standard=excluded.grid_fcfa_per_second_standard,
  grid_fcfa_per_second_premium=excluded.grid_fcfa_per_second_premium;

-- Les tarifs fal sont des estimations de coût unitaire; revalider avant activation commerciale.
update public.ai_models set is_active=false,is_default=false where fal_endpoint_id='fal-ai/kling-video/v2.6/pro/image-to-video';
update public.ai_models set is_default=false where tier='standard';
insert into public.ai_models(name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default)
values
  ('Kling O3 Pro','pro','fal-ai/kling-video/o3/pro/image-to-video','kling','image_to_video',0.112,'{5,10,15}','{16:9,9:16,1:1}',true,true),
  ('Seedance 2.5','premium','bytedance/seedance-2.5/image-to-video','seedance','image_to_video',0.473,'{10,15,20,30}','{16:9,9:16,1:1}',true,false),
  ('Veo 3.1 Fast','premium','fal-ai/veo3.1/fast/image-to-video','veo','image_to_video',0.10,'{6}','{16:9,9:16}',true,true),
  ('Hailuo 2.3 Pro','test','fal-ai/minimax/hailuo-2.3/pro/image-to-video','minimax','image_to_video',0,'{}','{}',false,false),
  ('Wan 3.0','standard','alibaba/wan-3.0/image-to-video','wan','image_to_video',0.10,'{5}','{16:9,9:16,1:1}',true,true)
on conflict(name) do update set tier=excluded.tier,fal_endpoint_id=excluded.fal_endpoint_id,
  adapter_family=excluded.adapter_family,mode=excluded.mode,price_usd_per_second=excluded.price_usd_per_second,
  allowed_durations=excluded.allowed_durations,allowed_formats=excluded.allowed_formats,
  is_active=excluded.is_active,is_default=excluded.is_default;

-- Routes reference-to-video dédiées au storyboard (les prix sont indicatifs et revalidés avant essai).
insert into public.ai_models(name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default)
values
  ('Wan 2.7 Reference to Video','standard','fal-ai/wan/v2.7/reference-to-video','wan','image_to_video',0.10,'{2,3,4,5,6,7,8,9,10}','{16:9,9:16,1:1,4:3,3:4}',true,false),
  ('Kling O3 Pro Reference to Video','pro','fal-ai/kling-video/o3/pro/reference-to-video','kling','image_to_video',0.112,'{3,4,5,6,7,8,9,10,11,12,13,14,15}','{16:9,9:16,1:1}',true,false),
  ('Seedance 2.5 Reference to Video','premium','bytedance/seedance-2.5/reference-to-video','seedance','image_to_video',0.473,'{4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30}','{16:9,9:16,1:1,4:3,3:4,21:9}',true,false)
on conflict(name) do update set tier=excluded.tier,fal_endpoint_id=excluded.fal_endpoint_id,
  adapter_family=excluded.adapter_family,mode=excluded.mode,price_usd_per_second=excluded.price_usd_per_second,
  allowed_durations=excluded.allowed_durations,allowed_formats=excluded.allowed_formats,is_active=excluded.is_active,is_default=false;
