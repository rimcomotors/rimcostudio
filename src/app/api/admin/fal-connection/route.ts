import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, requireRole } from '@/core/auth/guards';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { getFalCredentialStatus, replaceFalCredential } from '@/core/providers/fal-credential-vault';
import { env } from '@/env';

export const runtime = 'nodejs';

const replaceSchema = z.object({
  apiKey: z.string().trim().min(1, 'Saisissez la clé API Fal.').max(512, 'La clé API Fal est trop longue.')
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'La clé API Fal contient des caractères invalides.'),
}).strict();

export async function GET() {
  try {
    await requireRole('admin');
    if (env.PROVIDERS_MODE === 'mock' && !env.NEXT_PUBLIC_SUPABASE_URL) {
      return NextResponse.json({ configured: Boolean(env.FAL_KEY), source: env.FAL_KEY ? 'vercel' : 'none', updatedAt: null, encryptionReady: Boolean(env.FAL_CREDENTIALS_ENCRYPTION_KEY) });
    }
    return NextResponse.json(await getFalCredentialStatus());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireRole('admin');
    const input = replaceSchema.parse(await request.json());
    const result = await replaceFalCredential(input.apiKey, actor.id, createStorageAdminClient());
    return NextResponse.json({ configured: true, source: 'admin', updatedAt: result.updatedAt });
  } catch (error) {
    return errorResponse(error);
  }
}
