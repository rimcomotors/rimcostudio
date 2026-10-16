import { expect, test } from '@playwright/test';

const mockWithoutSupabase = process.env.E2E_MOCK_NO_SUPABASE === '1';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@rimco.test';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
const creatorEmail = process.env.E2E_CREATOR_EMAIL ?? 'collaborateur@rimco.test';

if (mockWithoutSupabase) {
  test('le studio de simulation est utilisable sans compte Supabase', async ({ page }) => {
    await page.goto('/studio');

    await expect(page.getByRole('heading', { name: 'Créer une vidéo' })).toBeVisible();
    await expect(page.getByText('Mode simulation', { exact: false })).toBeVisible();
    await expect(page.getByText('Durée de la vidéo')).toBeVisible();
    await expect(page.getByText('Niveau de génération')).toBeVisible();
    await expect(page.getByRole('button', { name: /Haval H6/ })).toBeVisible();
    await expect.poll(() => page.getByRole('img', { name: /Illustration de simulation.*Haval H6/ }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  });

  test('une génération simulée se consulte et se télécharge depuis la bibliothèque', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/studio');
    const title = `Essai RIMCO ${Date.now()}`;

    await page.getByLabel('Titre de la vidéo').fill(title);
    await page.getByLabel('Description de la vidéo').fill('Une lumière naturelle douce sur un boulevard calme.');
    const createRequest = page.waitForRequest((request) => request.url().endsWith('/api/versions') && request.method() === 'POST');
    await page.getByRole('button', { name: /Générer la vidéo/ }).click();
    expect((await createRequest).postDataJSON()).toMatchObject({ overlayLogo: true, title });

    await expect(page.getByText('Votre vidéo est prête à consulter.')).toBeVisible({ timeout: 65_000 });
    await page.getByRole('link', { name: 'Voir ma vidéo' }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.locator('video[aria-label^="Aperçu de"]').first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Télécharger le MP4' }).first().click();
    await expect(await download).toBeTruthy();
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

  test('administrateur génère, visionne et télécharge la vidéo simulée', async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, adminEmail, adminPassword);
    await page.goto('/studio');
    await page.getByLabel('Titre de la vidéo').fill('Essai E2E');
    await page.getByLabel('Description de la vidéo').fill('Une Haval H6 bleue roule doucement dans le Plateau à Abidjan.');
    const createRequest = page.waitForRequest((request) => request.url().endsWith('/api/versions') && request.method() === 'POST');
    await page.getByRole('button', { name: /Générer la vidéo/ }).click();
    expect((await createRequest).postDataJSON()).toMatchObject({ overlayLogo: true, title: 'Essai E2E' });
    await expect(page.getByText('Votre vidéo est prête à consulter.')).toBeVisible({ timeout: 65_000 });
    await page.getByRole('link', { name: 'Voir ma vidéo' }).click();
    await page.goto('/bibliotheque');
    await expect(page.locator('video[aria-label^="Aperçu de"]').first()).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Télécharger le MP4' }).first().click();
    await expect(await download).toBeTruthy();
  });
}
