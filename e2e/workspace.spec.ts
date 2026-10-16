import { expect, test } from '@playwright/test';

const mockWithoutSupabase = process.env.E2E_MOCK_NO_SUPABASE === '1';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@rimco.test';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

if (mockWithoutSupabase) {
  test('le studio de simulation est utilisable sans compte Supabase', async ({ page }) => {
    await page.goto('/studio');
    await expect(page.getByRole('heading', { name: 'Créer une vidéo' })).toBeVisible();
    await expect(page.getByText('Mode simulation', { exact: false })).toBeVisible();
    await expect(page.getByText('Durée de la vidéo')).toBeVisible();
    await expect(page.getByText('Niveau de génération')).toBeVisible();
    await expect(page.getByLabel('Véhicule')).toBeVisible();
    await expect(page.getByRole('option', { name: /Haval H6/ })).toBeAttached();
    await expect.poll(() => page.getByRole('img', { name: /Illustration de simulation.*Haval H6/ }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  });

  test('une génération simulée arrive à son état prêt', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/studio');
    await page.getByLabel('Véhicule').selectOption({ index: 1 });
    await expect(page.getByLabel('Véhicule')).not.toHaveValue('');
    await expect(page.getByText(/vue\(s\) rattachée/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Générer la vidéo/ })).toBeEnabled({ timeout: 15_000 });
    const title = `Essai RIMCO ${Date.now()}`;
    await page.getByLabel('Titre de la vidéo').fill(title);
    await page.getByLabel(/Précision complémentaire/).fill('Une lumière naturelle douce sur un boulevard calme.');
    const createRequest = page.waitForRequest((request) => request.url().endsWith('/api/versions') && request.method() === 'POST');
    await page.getByRole('button', { name: /Générer la vidéo/ }).click();
    expect((await createRequest).postDataJSON()).toMatchObject({ overlayLogo: true, title });
    await expect(page.getByText('Votre vidéo est prête à consulter.')).toBeVisible({ timeout: 65_000 });
    await expect(page.getByRole('link', { name: 'Voir ma vidéo' })).toBeVisible();
  });
} else {
  if (!adminPassword) throw new Error('E2E_ADMIN_PASSWORD doit être préparé par le setup global Playwright.');

  async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
    await page.goto('/connexion');
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByLabel('Mot de passe').fill(password);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL('/', { timeout: 10_000 });
  }

  test('connexion administrateur puis accès au studio de création', async ({ page }) => {
    await signIn(page, adminEmail, adminPassword);
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { name: /^Bonjour / })).toBeVisible();
    await page.getByRole('link', { name: 'Créer la vidéo' }).click();
    await expect(page.getByRole('heading', { name: 'Créer une vidéo' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Votre vidéo' })).toBeVisible();
    await expect(page.getByLabel('Véhicule')).toBeVisible();
    await expect(page.getByText('Durée de la vidéo')).toBeVisible();
    await expect(page.getByText('Niveau de génération')).toBeVisible();
  });

  test('administrateur lance une génération storyboard simulée', async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, adminEmail, adminPassword);
    await page.goto('/studio');
    await page.getByLabel('Véhicule').selectOption({ index: 1 });
    await expect(page.getByLabel('Véhicule')).not.toHaveValue('');
    await expect(page.getByText(/vue\(s\) rattachée/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Générer la vidéo/ })).toBeEnabled({ timeout: 15_000 });
    await page.getByLabel('Titre de la vidéo').fill('Essai E2E');
    await page.getByLabel('Description de la vidéo').fill('Une Haval H6 bleue roule doucement dans le Plateau à Abidjan.');
    const createRequest = page.waitForRequest((request) => request.url().endsWith('/api/versions') && request.method() === 'POST');
    await page.getByRole('button', { name: /Générer la vidéo/ }).click();
    expect((await createRequest).postDataJSON()).toMatchObject({ overlayLogo: true, title: 'Essai E2E' });
    await expect(page.getByText('Votre vidéo est prête à consulter.')).toBeVisible({ timeout: 65_000 });
    await expect(page.getByRole('link', { name: 'Voir ma vidéo' })).toBeVisible();
  });
}
