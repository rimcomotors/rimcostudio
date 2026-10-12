import { z } from 'zod';
const schema = z.object({
  PROVIDERS_MODE: z.enum(['mock','live']).default('mock'),
  FAL_KEY: z.string().optional(), LLM_MODEL: z.string().optional(),
  LLM_MAX_COST_USD: z.coerce.number().positive().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(), NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(), SUPABASE_SECRET_KEY: z.string().optional(),
  BUDGET_CAP_EUR: z.coerce.number().positive().default(20), FAL_BUDGET_CAP_USD: z.coerce.number().positive().default(10), USD_TO_EUR_RATE: z.coerce.number().positive().default(0.92),
  EUR_TO_FCFA: z.coerce.number().positive().default(655.957), APP_URL: z.string().url().optional(),
  FAL_WEBHOOK_SECRET: z.string().optional(), CRON_SECRET: z.string().optional()
}).superRefine((values, ctx) => {
  const publicKey = values.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (Boolean(values.NEXT_PUBLIC_SUPABASE_URL) !== Boolean(publicKey)) {
    ctx.addIssue({ code: 'custom', path: ['NEXT_PUBLIC_SUPABASE_URL'], message: 'Renseignez ensemble NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_ANON_KEY (ou NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).' });
  }
  if (values.PROVIDERS_MODE === 'live' && (!values.NEXT_PUBLIC_SUPABASE_URL || !publicKey)) {
    ctx.addIssue({ code: 'custom', path: ['NEXT_PUBLIC_SUPABASE_URL'], message: 'La configuration publique Supabase est obligatoire en mode live.' });
  }
  if (values.PROVIDERS_MODE === 'live' && !values.FAL_KEY) ctx.addIssue({ code: 'custom', path: ['FAL_KEY'], message: 'FAL_KEY est obligatoire en mode live.' });
  if (values.PROVIDERS_MODE === 'live' && !values.LLM_MODEL) ctx.addIssue({ code: 'custom', path: ['LLM_MODEL'], message: 'LLM_MODEL est obligatoire en mode live (identifiant de modèle OpenRouter/fal).'});
  if (values.PROVIDERS_MODE === 'live' && !values.LLM_MAX_COST_USD) ctx.addIssue({ code: 'custom', path: ['LLM_MAX_COST_USD'], message: 'LLM_MAX_COST_USD est obligatoire en mode live et doit couvrir le coût maximal d’une requête brief.' });
  if (values.PROVIDERS_MODE === 'live' && !values.SUPABASE_SERVICE_ROLE_KEY && !values.SUPABASE_SECRET_KEY) ctx.addIssue({ code: 'custom', path: ['SUPABASE_SERVICE_ROLE_KEY'], message: 'La clé secrète Supabase est obligatoire en mode live.' });
});
export const env = schema.parse(process.env);
export const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
export const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY;
/** Enforce both the internal EUR ceiling and the user's prepaid Fal test allowance. */
export const effectiveBudgetCapEur = Math.min(env.BUDGET_CAP_EUR, env.FAL_BUDGET_CAP_USD * env.USD_TO_EUR_RATE);
