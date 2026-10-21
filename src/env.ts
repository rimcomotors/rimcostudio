import { z } from 'zod';
const optionalSetting = z.preprocess((value) => typeof value === 'string' && value.trim() === '' ? undefined : value, z.string().optional());
const schema = z.object({
  PROVIDERS_MODE: z.enum(['mock','live']).default('mock'),
  FAL_KEY: z.string().optional(), FAL_CREDENTIALS_ENCRYPTION_KEY: z.string().optional(), LLM_MODEL: z.string().optional(),
  LLM_MAX_COST_USD: z.coerce.number().positive().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(), NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(), SUPABASE_SECRET_KEY: z.string().optional(),
  USD_TO_EUR_RATE: z.coerce.number().positive().default(0.92),
  EUR_TO_FCFA: z.coerce.number().positive().default(655.957), APP_URL: z.string().url().optional(),
  FAL_WEBHOOK_SECRET: z.string().optional(), CRON_SECRET: z.string().optional(),
  VIDEO_STORAGE_PROVIDER: z.enum(['supabase','r2']).default('supabase'),
  R2_ACCOUNT_ID: z.preprocess((value) => typeof value === 'string' && value.trim() === '' ? undefined : value, z.string().regex(/^[a-f0-9]{32}$/i, 'R2_ACCOUNT_ID doit être un identifiant Cloudflare de 32 caractères hexadécimaux.').optional()),
  R2_ACCESS_KEY_ID: optionalSetting, R2_SECRET_ACCESS_KEY: optionalSetting,
  R2_BUCKET: z.preprocess((value) => typeof value === 'string' && value.trim() === '' ? undefined : value, z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'R2_BUCKET doit être un nom de bucket Cloudflare valide.').optional()),
}).superRefine((values, ctx) => {
  const publicKey = values.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (Boolean(values.NEXT_PUBLIC_SUPABASE_URL) !== Boolean(publicKey)) {
    ctx.addIssue({ code: 'custom', path: ['NEXT_PUBLIC_SUPABASE_URL'], message: 'Renseignez ensemble NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_ANON_KEY (ou NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).' });
  }
  if (values.PROVIDERS_MODE === 'live' && (!values.NEXT_PUBLIC_SUPABASE_URL || !publicKey)) {
    ctx.addIssue({ code: 'custom', path: ['NEXT_PUBLIC_SUPABASE_URL'], message: 'La configuration publique Supabase est obligatoire en mode live.' });
  }
  if (values.PROVIDERS_MODE === 'live' && !values.FAL_KEY && !values.FAL_CREDENTIALS_ENCRYPTION_KEY) ctx.addIssue({ code: 'custom', path: ['FAL_KEY'], message: 'Configurez FAL_KEY dans Vercel ou ajoutez une clé Fal chiffrée depuis l’administration.' });
  if (values.FAL_CREDENTIALS_ENCRYPTION_KEY) {
    const encryptionKey = Buffer.from(values.FAL_CREDENTIALS_ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== values.FAL_CREDENTIALS_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['FAL_CREDENTIALS_ENCRYPTION_KEY'], message: 'FAL_CREDENTIALS_ENCRYPTION_KEY doit être une clé Base64 de 32 octets.' });
    }
  }
  if (values.PROVIDERS_MODE === 'live' && !values.LLM_MODEL) ctx.addIssue({ code: 'custom', path: ['LLM_MODEL'], message: 'LLM_MODEL est obligatoire en mode live (identifiant de modèle OpenRouter/fal).'});
  if (values.PROVIDERS_MODE === 'live' && !values.LLM_MAX_COST_USD) ctx.addIssue({ code: 'custom', path: ['LLM_MAX_COST_USD'], message: 'LLM_MAX_COST_USD est obligatoire en mode live et doit couvrir le coût maximal d’une requête brief.' });
  if (values.PROVIDERS_MODE === 'live' && !values.SUPABASE_SERVICE_ROLE_KEY && !values.SUPABASE_SECRET_KEY) ctx.addIssue({ code: 'custom', path: ['SUPABASE_SERVICE_ROLE_KEY'], message: 'La clé secrète Supabase est obligatoire en mode live.' });
  if (values.VIDEO_STORAGE_PROVIDER === 'r2') {
    for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const) {
      if (!values[key]?.trim()) ctx.addIssue({ code: 'custom', path: [key], message: `${key} est obligatoire lorsque VIDEO_STORAGE_PROVIDER=r2.` });
    }
  }
});
export const env = schema.parse(process.env);
export const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
export const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY;
