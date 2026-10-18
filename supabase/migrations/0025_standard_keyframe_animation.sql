-- Standard now animates accepted keyframes with Wan 3.0 Image-to-Video.
-- Fal documents start_image_url, 5-second duration, 16:9/9:16/1:1, and $0.10/s at 720p (checked 2026-10-18).
update public.ai_models set
  tier='standard', adapter_family='wan', mode='image_to_video',
  is_active=true, price_usd_per_second=0.10, allowed_durations='{5}',
  allowed_formats='{16:9,9:16,1:1}', pricing_verified_at=now()
where fal_endpoint_id='alibaba/wan-3.0/image-to-video';
notify pgrst, 'reload schema';
