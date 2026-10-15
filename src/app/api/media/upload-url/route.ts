import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, getActor } from '@/core/auth/guards';
import { env } from '@/env';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { assertPlaceUploadAdmin } from '@/core/assets/permissions';
const schema = z.object({ fileName: z.string().trim().min(1).max(160), contentType: z.enum(['image/jpeg','image/png','image/webp','audio/mpeg','audio/wav','audio/mp4']), kind: z.enum(['vehicle','logo','audio','place','decor','wardrobe','badge']) }).refine((v) => v.kind === 'audio' ? v.contentType.startsWith('audio/') : v.contentType.startsWith('image/'), { message: 'Le type de fichier ne correspond pas au média.' });
export async function POST(request: Request) {
  try {
    const actor = await getActor();
    const input = schema.parse(await request.json());
    if (input.kind === 'place') assertPlaceUploadAdmin(actor.role);
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.json({ path: `mock/${crypto.randomUUID()}`, uploadUrl: null, token: null, mock: true });
    const admin = createStorageAdminClient();
    const path = `${actor.id}/${crypto.randomUUID()}`;
    const { data, error } = await admin.storage.from(input.kind === 'audio' ? 'audio' : input.kind === 'logo' ? 'brand' : 'assets').createSignedUploadUrl(path);
    if (error) throw error;
    return NextResponse.json({ path, uploadUrl: data.signedUrl, token: data.token, bucket: input.kind === 'audio' ? 'audio' : input.kind === 'logo' ? 'brand' : 'assets' });
  } catch (error) { return errorResponse(error); }
}
