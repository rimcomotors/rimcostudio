import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isLocalSupabaseUrl } from './local-supabase';

export default async function globalSetup() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !isLocalSupabaseUrl(url)) {
    throw new Error('Les tests E2E exigent une URL Supabase locale en HTTP (localhost, 127.0.0.1 ou ::1). Aucune donnée distante ne sera modifiée.');
  }
  if (!key) throw new Error('La clé Supabase service role locale est requise pour les tests E2E.');

  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@rimco.test';
  const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? `${crypto.randomUUID()}Aa1!`;
  process.env.E2E_ADMIN_PASSWORD = adminPassword;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error('La clé publique Supabase locale est requise pour les tests E2E.');
  const admin = await ensureUser(supabase, url, anonKey, adminEmail, adminPassword, 'Administrateur test');
  const { data: brand, error: brandError } = await supabase.from('brands').select('id').eq('name', 'RIMCO Motors').single();
  if (brandError || !brand) throw new Error('La marque RIMCO Motors est absente du seed Supabase.');

  const creatorEmail = process.env.E2E_CREATOR_EMAIL ?? 'collaborateur@rimco.test';
  const validatorEmail = process.env.E2E_VALIDATOR_EMAIL ?? 'valideur@rimco.test';
  const creator = await ensureUser(supabase, url, anonKey, creatorEmail, adminPassword, 'Collaborateur E2E');
  const validator = await ensureUser(supabase, url, anonKey, validatorEmail, adminPassword, 'Valideur E2E');
  for (const [user, role] of [[creator, 'collaborateur'], [validator, 'valideur']] as const) {
    const { error } = await supabase.from('profiles').update({ role, brand_id: brand.id, department: 'Marketing', is_active: true }).eq('id', user.id);
    if (error) throw new Error(`Impossible de préparer le profil ${role} pour E2E: ${error.message}`);
  }

  const path = `${admin.id}/${crypto.randomUUID()}-vehicle.png`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xa8AAAAASUVORK5CYII=', 'base64');
  const { error: uploadError } = await supabase.storage.from('assets').upload(path, png, { contentType: 'image/png' });
  if (uploadError) throw uploadError;
  const { error: assetError } = await supabase.from('assets').insert({
    kind: 'vehicle', path, make: 'Haval', model: 'H6', color: 'Bleu nuit', angle: 'Avant trois-quarts',
    status: 'validée', brand_id: brand.id, created_by: admin.id,
  });
  if (assetError) throw assetError;
}

async function ensureUser(supabase: SupabaseClient, url: string, anonKey: string, email: string, password: string, name: string) {
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
  let user = data.user;
  if (error) {
    if (!error.message.toLowerCase().includes('already')) throw error;
    const { data: page, error: listError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) throw listError;
    user = page.users.find((candidate) => candidate.email === email) ?? null;
  }
  if (!user) throw new Error(`Le compte E2E ${email} est introuvable.`);
  const { data: refreshed, error: refreshError } = await supabase.auth.admin.updateUserById(user.id, {
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (refreshError || !refreshed.user) throw refreshError ?? new Error(`Impossible de réinitialiser le compte E2E ${email}.`);
  const authCheck = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await authCheck.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`Le compte E2E ${email} ne peut pas ouvrir de session après sa préparation : ${signInError.message}`);
  return refreshed.user;
}
