-- Keyframes are private video-generation artifacts stored alongside their final MP4s.
-- Preserve existing bucket MIME types while allowing the image formats returned by fal.
update storage.buckets
set allowed_mime_types = (
  select array_agg(distinct mime_type order by mime_type)
  from unnest(coalesce(allowed_mime_types, array[]::text[]) || array['image/jpeg','image/png','image/webp']::text[]) as mime_type
)
where id = 'videos';
